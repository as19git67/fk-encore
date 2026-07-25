import Foundation
import Network
import Photos

/// Executes a photo sync cycle: reads from the iOS Photos library and
/// uploads assets to the server according to the current preferences.
///
/// Algorithm (hash-based sync pipeline, issue #432):
///  1. Enumerate all image-type PHAssets (videos explicitly excluded).
///  2. Compute X-Full-Hash for each asset via PhotoHasher (cached by modificationDate).
///  3. POST /photos/sync/check with up to 5000 hashes per batch to get the server's
///     existing set.
///  4. Upload every asset whose full-hash is NOT in the existing set.
///  5. A pure metadata change (caption, favorite, date) flips the full-hash and runs
///     through the same upload path — no separate PATCH sweep needed.
actor PhotoSyncService {
    static let shared = PhotoSyncService()

    private let monitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "dev.fk-encore.NetworkMonitor")
    /// Latest path delivered by the monitor. `nil` until the first update lands.
    /// Reading `monitor.currentPath` synchronously right after `start` is not
    /// reliable — interface types in particular aren't populated until the first
    /// async update arrives, so the first "Jetzt synchronisieren" tap reported
    /// "no WiFi" and the user had to tap twice. We now wait for that first update
    /// (see `awaitFirstPath`).
    private var currentPath: NWPath?
    /// Continuations waiting for the monitor's first path update.
    private var firstPathWaiters: [UUID: CheckedContinuation<Void, Never>] = [:]

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            Task { await self?.updatePath(path) }
        }
        monitor.start(queue: monitorQueue)
    }

    private func updatePath(_ path: NWPath) {
        currentPath = path
        let waiters = firstPathWaiters
        firstPathWaiters.removeAll()
        for (_, cont) in waiters { cont.resume() }
    }

    /// Wait (briefly) for the monitor's first path update if it hasn't arrived
    /// yet, so the first connectivity query after launch reflects reality
    /// instead of a not-yet-populated path. Bounded by a safety timeout so a
    /// sync tap can never hang.
    private func awaitFirstPath() async {
        if currentPath != nil { return }
        let id = UUID()
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            firstPathWaiters[id] = cont
            Task {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                await self.resumeFirstPathWaiter(id)
            }
        }
    }

    private func resumeFirstPathWaiter(_ id: UUID) {
        firstPathWaiters.removeValue(forKey: id)?.resume()
    }

    /// True while connected via WiFi. Awaits the first monitor update so the
    /// value is correct on the very first call after launch.
    var isWifiConnected: Bool {
        get async {
            await awaitFirstPath()
            return (currentPath ?? monitor.currentPath).usesInterfaceType(.wifi)
        }
    }

    var isNetworkAvailable: Bool {
        get async {
            await awaitFirstPath()
            return (currentPath ?? monitor.currentPath).status == .satisfied
        }
    }

    // MARK: - Public sync entry point

    /// Run one sync cycle. Returns silently if preconditions (enabled, auth,
    /// network) aren't met.
    ///
    /// Pipeline:
    ///  1. Drain whatever is already in the UploadQueue (Share-Extension items,
    ///     queue leftovers from a prior interrupted run) so the user sees
    ///     progress immediately instead of waiting through library scan.
    ///  2. Enumerate the configured iOS albums (or the entire library when the
    ///     `__all_photos__` sentinel is selected).
    ///  3. For each 500-asset batch: compute hashes (cached by modificationDate),
    ///     ask the server which full-hashes it already has, enqueue the rest.
    ///  4. After each batch advance the per-album watermark to the batch's
    ///     newest `creationDate`. An interruption mid-run loses at most one
    ///     batch on resume instead of the whole enumeration.
    func sync() async throws {
        guard PhotoSyncPreferences.syncEnabled else { return }

        await SyncProgress.shared.update(.waitingForNetwork)
        // Single source of truth for the WiFi-only / connectivity gate, shared
        // with the queue drain so both honour a live preference toggle.
        guard await BackgroundSyncManager.networkAllowsUpload() else {
            await SyncProgress.shared.reset()
            return
        }

        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else {
            await SyncProgress.shared.reset()
            return
        }

        // Clean up legacy configs that target a smart album (Favoriten, Recents,
        // …) before anything enumerates or reconciles them. Runs with photo
        // access available (guaranteed by the guard above) so classification is
        // reliable, and before syncAlbumDeletions() so a legacy sync/bisync
        // smart-album mapping can't trigger a server-side removal.
        purgeLegacySmartAlbumsIfNeeded()

        do {
            // Step 1: Drain whatever's already queued — Share-Extension items, or
            // pending items from a prior interrupted sync. This used to happen only
            // AFTER the (potentially minute-long) library scan, so the user stared
            // at a spinner thinking nothing was happening.
            await drainQueueWithProgress()

            // Sync-mode deletion reconciliation (issue #812 "Sync" mode): remove
            // server-album entries whose source asset has left the iOS album.
            // Runs before — and independently of — the upload scan, so removals
            // apply even when there is nothing new to upload.
            await syncAlbumDeletions()

            await SyncProgress.shared.update(.scanningLibrary)
            let syncStartDate = Date()
            let assets = await fetchAssets()
            await SyncProgress.shared.setTotalAssets(assets.count)

            guard !assets.isEmpty else {
                PhotoSyncPreferences.lastSyncDate = syncStartDate
                await SyncProgress.shared.reset()
                return
            }

            // Small on purpose (issue: manual sync interrupted by backgrounding
            // always restarted from scratch). At ~30s/100 photos, a 500-item
            // batch took minutes to hash — far longer than the OS typically
            // grants a backgrounded app before suspending or jetsam-killing it,
            // so the per-album watermark (only advanced once per batch, see
            // Step 5 below) never moved and every retry re-scanned from the
            // same starting point. 50 keeps each batch's checkpoint reachable
            // within a few seconds, so an interruption loses at most a few
            // seconds of hashing instead of the whole batch.
            let processingBatchSize = 50
            var processedCount = 0
            // Per album, the oldest creationDate of an asset we FAILED to process
            // this run (typically because its iCloud original wasn't available to
            // hash). The watermark must never advance to or past these, otherwise
            // the strict `creationDate >` enumeration predicate would skip them
            // forever and they'd never be retried.
            var earliestUnhashedByAlbum: [String: Date] = [:]
            for batchStart in stride(from: 0, to: assets.count, by: processingBatchSize) {
                try Task.checkCancellation()
                let assetBatch = assets[batchStart..<min(batchStart + processingBatchSize, assets.count)]

                // Step 2: Compute full-hash for each asset (PhotoHasher caches by modificationDate).
                await SyncProgress.shared.update(.hashingBatch(done: processedCount, total: assets.count))
                var hashPairs: [(asset: PHAsset, filename: String, sourceAlbumId: String?, hashResult: PhotoHashResult)] = []
                for (asset, filename, sourceAlbumId) in assetBatch {
                    // Per-asset cancellation check: hashing reads asset bytes and
                    // isn't cancellation-aware itself, so without this a BG-task
                    // expiry would keep hashing to the end of the current batch.
                    // Aborting mid-batch only loses that batch's progress (up to
                    // `processingBatchSize` assets) — already-cached hashes and
                    // the previously advanced watermark are unaffected.
                    try Task.checkCancellation()
                    guard let result = await PhotoHasher.shared.hashes(for: asset) else {
                        // Hash failed — remember the oldest such asset per album so
                        // the watermark can't sail past it (see comment above).
                        if let sourceAlbumId, let created = asset.creationDate,
                           (earliestUnhashedByAlbum[sourceAlbumId].map { created < $0 } ?? true) {
                            earliestUnhashedByAlbum[sourceAlbumId] = created
                        }
                        continue
                    }
                    hashPairs.append((asset, filename, sourceAlbumId, result))
                }

                if !hashPairs.isEmpty {
                    // Step 3: Sync-check to find which full-hashes the server already has.
                    await SyncProgress.shared.update(.checkingServer(batchSize: hashPairs.count))
                    let batchHashes = hashPairs.map { $0.hashResult.fullHash }
                    let serverHas = Set((try? await APIClient.shared.syncCheck(hashes: batchHashes)) ?? [])

                    // Step 4: Enqueue assets whose full-hash the server doesn't have.
                    let alreadyQueued = Set(await UploadQueue.shared.pendingItems().map(\.fullHash))

                    let missing = hashPairs.filter {
                        !serverHas.contains($0.hashResult.fullHash)
                        && !alreadyQueued.contains($0.hashResult.fullHash)
                    }

                    for item in missing {
                        // Shared with the manual-album upload (Part A): identical
                        // hash/metadata/resource selection so both paths dedup the
                        // same way server-side (issue #591).
                        guard let queueItem = await AssetUploadEnqueuer.makeQueueItem(
                            for: item.asset,
                            precomputedHash: item.hashResult,
                            filenameHint: item.filename,
                            targetAlbumIds: resolveTargetAlbumIds(sourceAlbumId: item.sourceAlbumId),
                            sourceIosAlbumId: item.sourceAlbumId
                        ) else { continue }
                        await UploadQueue.shared.enqueue(queueItem)
                    }
                    if !missing.isEmpty {
                        await drainQueueWithProgress()
                    }
                }

                // Step 5: Advance the per-album watermark to the newest
                // creationDate among assets we successfully processed (hash
                // computed). We deliberately exclude assets whose hash failed
                // (typically because iCloud bytes weren't available) so they get
                // retried on the next run instead of being silently skipped.
                advanceWatermarksForProcessed(hashPairs, earliestUnhashedByAlbum: earliestUnhashedByAlbum)
                processedCount += assetBatch.count
            }

            // Final pass: drain anything still pending plus mark the overall sync
            // timestamp. The per-album watermarks were already advanced above.
            await drainQueueWithProgress()
            PhotoSyncPreferences.lastSyncDate = syncStartDate
            await SyncProgress.shared.reset()
        } catch {
            // Ensure the progress indicator is always cleared on any exit path
            // (e.g. Task cancellation when a BGProcessingTask time limit expires),
            // so the spinner never stays visible after the sync has stopped.
            await SyncProgress.shared.reset()
            throw error
        }
    }

    /// Wraps `BackgroundSyncManager.drainUploadQueue` so the progress observer
    /// always reflects what the queue is doing right now.
    private func drainQueueWithProgress() async {
        let remaining = await UploadQueue.shared.inFlightCount()
        guard remaining > 0 else { return }
        await SyncProgress.shared.update(.drainingQueue(remaining: remaining))
        await BackgroundSyncManager.shared.drainUploadQueue()
    }

    /// Advances the per-album watermark to the newest creationDate among the
    /// assets we successfully processed in this batch — but never to or past an
    /// asset that failed to process this run (`earliestUnhashedByAlbum`). The
    /// `advanceAlbumSyncDate` helper only writes when strictly newer, so
    /// out-of-order completions never roll the watermark backwards.
    private func advanceWatermarksForProcessed(
        _ pairs: [(asset: PHAsset, filename: String, sourceAlbumId: String?, hashResult: PhotoHashResult)],
        earliestUnhashedByAlbum: [String: Date]
    ) {
        let processed: [(albumId: String, created: Date)] = pairs.compactMap { pair in
            guard let albumId = pair.sourceAlbumId, let created = pair.asset.creationDate else { return nil }
            return (albumId, created)
        }
        for (albumId, date) in Self.safeWatermarks(
            processed: processed,
            earliestUnhashed: earliestUnhashedByAlbum
        ) {
            PhotoSyncPreferences.advanceAlbumSyncDate(date, for: albumId)
        }
    }

    /// Pure watermark computation (unit-tested): per album, the newest processed
    /// `creationDate` that is strictly older than the album's earliest
    /// *unprocessed* asset. Assets at or after a failure are excluded so the
    /// strict `creationDate >` enumeration predicate re-includes the failed asset
    /// (and everything after it) on the next run instead of skipping it forever.
    static func safeWatermarks(
        processed: [(albumId: String, created: Date)],
        earliestUnhashed: [String: Date]
    ) -> [String: Date] {
        var result: [String: Date] = [:]
        for entry in processed {
            if let failed = earliestUnhashed[entry.albumId], entry.created >= failed { continue }
            if let existing = result[entry.albumId], existing >= entry.created { continue }
            result[entry.albumId] = entry.created
        }
        return result
    }

    private func resolveTargetAlbumIds(sourceAlbumId: String?) -> [Int] {
        sourceAlbumId.flatMap { PhotoSyncPreferences.albumMappings[$0] }.map { [$0] } ?? []
    }

    // MARK: - Legacy smart-album purge (issue #812 follow-up)

    /// One-time cleanup: a config from before smart albums were hidden could
    /// still reference a smart/system album (selected via the old settings
    /// picker). Those can no longer be seen or disconnected in the UI and their
    /// dynamically-managed membership makes them unsafe to sync, so remove any
    /// smart-album ids from the sync config. Guarded by a flag so it runs once;
    /// classifies stored ids via PhotoKit, which is why it lives here (photo
    /// access is already established when this is called).
    private func purgeLegacySmartAlbumsIfNeeded() {
        guard !PhotoSyncPreferences.smartAlbumPurgeDone else { return }
        let ids = PhotoSyncPreferences.selectedAlbumIds.filter {
            $0 != PhotoSyncPreferences.allLibrarySentinel
        }
        guard !ids.isEmpty else {
            PhotoSyncPreferences.smartAlbumPurgeDone = true
            return
        }

        var smartIds = Set<String>()
        PHAssetCollection
            .fetchAssetCollections(withLocalIdentifiers: Array(ids), options: nil)
            .enumerateObjects { collection, _, _ in
                if collection.assetCollectionType == .smartAlbum {
                    smartIds.insert(collection.localIdentifier)
                }
            }

        PhotoSyncPreferences.purgeAlbumsFromConfig(smartIds)
        PhotoSyncPreferences.smartAlbumPurgeDone = true
    }

    // MARK: - Deletion sync (issue #812 "Sync" mode)

    /// For every confirmed sync-mode album, removes server-album entries whose
    /// source iOS asset has left the iOS album. Safety properties:
    ///  - Only photos this device uploaded (present in `serverPhotoMap`) are ever
    ///    touched — photos added on the web are never removed.
    ///  - Bisync albums additionally require the photo to be registered in the
    ///    album's download tracking, so a server-side addition that hasn't been
    ///    synced down yet is never mistaken for a local removal.
    ///  - Only the album membership is removed (`action: "remove"`); the photo
    ///    itself stays on the server.
    ///  - A collection that fails to resolve is skipped, so a transient PhotoKit
    ///    hiccup can't wipe a whole server album.
    ///  - Copy-mode albums are untouched.
    private func syncAlbumDeletions() async {
        let mappings = PhotoSyncPreferences.albumMappings
        guard !mappings.isEmpty else { return }
        let confirmed = PhotoSyncPreferences.confirmedMappingIds
        // serverPhotoMap: [serverPhotoId(String): iOS localIdentifier]
        let serverPhotoMap = PhotoSyncPreferences.loadServerPhotoMap()
        guard !serverPhotoMap.isEmpty else { return }

        for (iosAlbumId, serverAlbumId) in mappings {
            // Each album is one GET + one idempotent batch-remove; stop between
            // albums when the BG task is being expired.
            if Task.isCancelled { return }
            let mode = PhotoSyncPreferences.albumSyncMode(for: iosAlbumId)
            guard confirmed.contains(iosAlbumId),
                  mode == .sync || mode == .bisync else { continue }

            // Current iOS album membership (local identifiers only — no hashing).
            // nil means the collection couldn't be read; skip to avoid a wipe.
            guard let presentLocalIds = await Self.fetchAlbumAssetLocalIds(iosAlbumId) else { continue }

            struct MinimalPhoto: Decodable { let id: Int }
            struct PhotosResponse: Decodable { let photos: [MinimalPhoto] }
            let response: PhotosResponse? = try? await APIClient.shared.get("/albums/\(serverAlbumId)/photos")
            guard let serverPhotos = response?.photos else { continue }

            // Bisync: a server photo counts as "was in the iOS album" only once
            // the download half has registered it for this album pair. The
            // global serverPhotoMap alone is NOT sufficient evidence — a photo
            // uploaded from this device via another album or the whole-library
            // sync, then added to the album on the web, has a local asset that
            // was never in this iOS album. Treating its absence as a removal
            // deleted server-side additions before they could ever sync down.
            let bisyncTracked: Set<String>? = mode == .bisync
                ? Set((DownloadSyncPreferences.loadDownloadedPhotos()[String(serverAlbumId)] ?? [:]).keys)
                : nil

            // Photos we uploaded whose source asset is no longer in the iOS album.
            let toRemove: [Int] = serverPhotos.compactMap { photo in
                if let tracked = bisyncTracked, !tracked.contains(String(photo.id)) { return nil }
                guard let localId = serverPhotoMap[String(photo.id)] else { return nil }
                return presentLocalIds.contains(localId) ? nil : photo.id
            }
            guard !toRemove.isEmpty else { continue }

            struct BatchBody: Encodable {
                let albumIds: [Int]
                let photoIds: [Int]
                let action: String
            }
            struct BatchResponse: Decodable { let success: Bool }
            let _: BatchResponse? = try? await APIClient.shared.post(
                "/albums/photos/batch",
                body: BatchBody(albumIds: [serverAlbumId], photoIds: toRemove, action: "remove")
            )

            // Bisync: keep the download half in step. Forget these photos in the
            // download tracking so PhotoDownloadService doesn't later see them as
            // "removed on the server" and move the still-present local asset into
            // "F4mil Trash". No-op for pure sync albums (not in the download set).
            if mode == .bisync {
                DownloadSyncPreferences.forgetDownloadedPhotos(albumId: serverAlbumId, photoIds: toRemove)
            }
        }
    }

    /// Fetches the current image-asset local identifiers of an iOS album.
    /// Returns nil when the collection can't be resolved (never an empty set in
    /// that case) so callers can distinguish "empty album" from "unreadable".
    private static func fetchAlbumAssetLocalIds(_ iosAlbumId: String) async -> Set<String>? {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let collections = PHAssetCollection.fetchAssetCollections(
                    withLocalIdentifiers: [iosAlbumId], options: nil
                )
                guard let collection = collections.firstObject else {
                    continuation.resume(returning: nil)
                    return
                }
                let options = PHFetchOptions()
                options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
                var ids = Set<String>()
                PHAsset.fetchAssets(in: collection, options: options).enumerateObjects { asset, _, _ in
                    ids.insert(asset.localIdentifier)
                }
                continuation.resume(returning: ids)
            }
        }
    }

    // MARK: - Asset fetching

    // Dispatches to a background queue so PHFetchResult.enumerateObjects doesn't
    // block the Swift concurrency cooperative thread pool (avoids unsafeForcedSync warning).
    // Filenames are pre-fetched here so PHAssetResource.assetResources is never called
    // inside the PHImageManager completion handler (avoids main-queue metadata warning).
    // The third tuple element is the source iOS album localIdentifier.
    private func fetchAssets() async -> [(PHAsset, String, String?)] {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: Self.fetchAssetsSync())
            }
        }
    }

    private static func fetchAssetsSync() -> [(PHAsset, String, String?)] {
        let albumIds = PhotoSyncPreferences.selectedAlbumIds
        guard !albumIds.isEmpty else { return [] }

        let confirmed = PhotoSyncPreferences.confirmedMappingIds
        // Never re-upload assets this device downloaded from the server (bisync
        // round-trip guard): the server already has them, and a re-encoded
        // downloaded copy would carry a different image_data_hash, so the server
        // dedup would miss it and store a near-duplicate that loops back onto the
        // device as a visible duplicate.
        let downloadedIds = DownloadSyncPreferences.loadDownloadedAssetIds()

        var pairs: [(PHAsset, String?)] = []
        var seen = Set<String>()

        // "Gesamte Mediathek" sentinel: enumerate every image asset directly,
        // bypassing per-album collections. Other selections are ignored when
        // the sentinel is present so the user can't accidentally double-sync.
        if albumIds.contains(PhotoSyncPreferences.allLibrarySentinel),
           confirmed.contains(PhotoSyncPreferences.allLibrarySentinel) {
            let lastSync = PhotoSyncPreferences.albumSyncDate(for: PhotoSyncPreferences.allLibrarySentinel)
            let options = buildFetchOptions(lastSync: lastSync)
            PHAsset.fetchAssets(with: .image, options: options)
                .enumerateObjects { asset, _, _ in
                    if seen.insert(asset.localIdentifier).inserted {
                        pairs.append((asset, PhotoSyncPreferences.allLibrarySentinel))
                    }
                }
        } else {
            let confirmedAlbumIds = albumIds.filter { confirmed.contains($0) }
            PHAssetCollection
                .fetchAssetCollections(withLocalIdentifiers: Array(confirmedAlbumIds), options: nil)
                .enumerateObjects { collection, _, _ in
                    let albumLastSync = PhotoSyncPreferences.albumSyncDate(for: collection.localIdentifier)
                    let options = buildFetchOptions(lastSync: albumLastSync)
                    PHAsset.fetchAssets(in: collection, options: options)
                        .enumerateObjects { asset, _, _ in
                            guard asset.mediaType == .image else { return }
                            if seen.insert(asset.localIdentifier).inserted {
                                pairs.append((asset, collection.localIdentifier))
                            }
                        }
                }
        }

        return pairs
            .filter { !downloadedIds.contains($0.0.localIdentifier) }
            .map { (asset, sourceAlbumId) in
                let filename = AssetUploadEnqueuer.originalFilename(for: asset)
                    ?? "photo_\(asset.localIdentifier.prefix(8)).jpg"
                return (asset, filename, sourceAlbumId)
            }
    }

    private static func buildFetchOptions(lastSync: Date?) -> PHFetchOptions {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        options.includeHiddenAssets = false
        var predicates: [NSPredicate] = []
        if let lastSync {
            predicates.append(NSCompoundPredicate(orPredicateWithSubpredicates: [
                NSPredicate(format: "creationDate > %@", lastSync as NSDate),
                NSPredicate(format: "modificationDate > %@", lastSync as NSDate)
            ]))
        }
        if PhotoSyncPreferences.excludeScreenshots {
            predicates.append(NSPredicate(format: "NOT ((mediaSubtype & %d) != 0)",
                                          PHAssetMediaSubtype.photoScreenshot.rawValue))
        }
        if !predicates.isEmpty {
            options.predicate = predicates.count == 1
                ? predicates[0]
                : NSCompoundPredicate(andPredicateWithSubpredicates: predicates)
        }
        return options
    }

    // MARK: - Asset data loading

    /// Loads the original PHAssetResource bytes for uploading. Using the original resource
    /// (not PHImageManager-rendered bytes) ensures the uploaded content matches the
    /// imageDataHash and that caption/favorite edits don't cause re-uploads.
    static func loadAssetData(_ asset: PHAsset) async throws -> (Data, String) {
        // Upload the *edited* render when present (matches the hashed bytes),
        // falling back to the original for never-edited assets (issue #591).
        guard let resource = AssetUploadEnqueuer.bestResource(for: asset)
        else {
            throw SyncError.noImageData
        }

        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true

        return try await withCheckedThrowingContinuation { continuation in
            var data = Data()
            PHAssetResourceManager.default().requestData(for: resource, options: options) { chunk in
                data.append(chunk)
            } completionHandler: { error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                let mimeType = Self.mimeType(for: resource.uniformTypeIdentifier)
                continuation.resume(returning: (data, mimeType))
            }
        }
    }

    static func mimeType(for uniformTypeIdentifier: String) -> String {
        let lower = uniformTypeIdentifier.lowercased()
        if lower.contains("heic") || lower.contains("heif") { return "image/heic" }
        if lower.contains("png")  { return "image/png" }
        if lower.contains("tiff") { return "image/tiff" }
        if lower.contains("webp") { return "image/webp" }
        return "image/jpeg"
    }

    enum SyncError: LocalizedError {
        case noImageData
        var errorDescription: String? { "Keine Bilddaten verfügbar" }
    }
}
