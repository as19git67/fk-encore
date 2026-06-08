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

    private init() {
        // No path-update handler needed: `monitor.currentPath` is non-optional
        // and reflects the live state after `start`. The previous cached `var
        // currentPath: NWPath?` was nil until the first async update arrived,
        // which made the first "Jetzt synchronisieren" tap silently no-op
        // (issue: user had to tap twice).
        monitor.start(queue: monitorQueue)
    }

    /// True while connected via WiFi. Reads `monitor.currentPath` directly so
    /// the value is correct on the very first call after launch.
    var isWifiConnected: Bool {
        monitor.currentPath.usesInterfaceType(.wifi)
    }

    private var isNetworkAvailable: Bool {
        monitor.currentPath.status == .satisfied
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
        if PhotoSyncPreferences.wifiOnly {
            guard isWifiConnected else { await SyncProgress.shared.reset(); return }
        } else {
            guard isNetworkAvailable else { await SyncProgress.shared.reset(); return }
        }

        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else {
            await SyncProgress.shared.reset()
            return
        }

        // Step 1: Drain whatever's already queued — Share-Extension items, or
        // pending items from a prior interrupted sync. This used to happen only
        // AFTER the (potentially minute-long) library scan, so the user stared
        // at a spinner thinking nothing was happening.
        await drainQueueWithProgress()

        await SyncProgress.shared.update(.scanningLibrary)
        let syncStartDate = Date()
        let assets = await fetchAssets()
        await SyncProgress.shared.setTotalAssets(assets.count)

        guard !assets.isEmpty else {
            PhotoSyncPreferences.lastSyncDate = syncStartDate
            await SyncProgress.shared.reset()
            return
        }

        let processingBatchSize = 500
        var processedCount = 0
        for batchStart in stride(from: 0, to: assets.count, by: processingBatchSize) {
            try Task.checkCancellation()
            let assetBatch = assets[batchStart..<min(batchStart + processingBatchSize, assets.count)]

            // Step 2: Compute full-hash for each asset (PhotoHasher caches by modificationDate).
            await SyncProgress.shared.update(.hashingBatch(done: processedCount, total: assets.count))
            var hashPairs: [(asset: PHAsset, filename: String, sourceAlbumId: String?, hashResult: PhotoHashResult)] = []
            for (asset, filename, sourceAlbumId) in assetBatch {
                guard let result = await PhotoHasher.shared.hashes(for: asset) else { continue }
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
            advanceWatermarksForProcessed(hashPairs)
            processedCount += assetBatch.count
        }

        // Final pass: drain anything still pending plus mark the overall sync
        // timestamp. The per-album watermarks were already advanced above.
        await drainQueueWithProgress()
        PhotoSyncPreferences.lastSyncDate = syncStartDate
        await SyncProgress.shared.reset()
    }

    /// Wraps `BackgroundSyncManager.drainUploadQueue` so the progress observer
    /// always reflects what the queue is doing right now.
    private func drainQueueWithProgress() async {
        let remaining = await UploadQueue.shared.inFlightCount()
        guard remaining > 0 else { return }
        await SyncProgress.shared.update(.drainingQueue(remaining: remaining))
        await BackgroundSyncManager.shared.drainUploadQueue()
    }

    /// Stores the newest creationDate per source album over the assets we
    /// successfully processed in this batch. The `advanceAlbumSyncDate` helper
    /// only writes when strictly newer, so out-of-order completions never
    /// roll the watermark backwards.
    private func advanceWatermarksForProcessed(
        _ pairs: [(asset: PHAsset, filename: String, sourceAlbumId: String?, hashResult: PhotoHashResult)]
    ) {
        var perAlbumMax: [String: Date] = [:]
        for pair in pairs {
            guard let sourceAlbumId = pair.sourceAlbumId,
                  let created = pair.asset.creationDate else { continue }
            if let existing = perAlbumMax[sourceAlbumId], existing >= created { continue }
            perAlbumMax[sourceAlbumId] = created
        }
        for (albumId, date) in perAlbumMax {
            PhotoSyncPreferences.advanceAlbumSyncDate(date, for: albumId)
        }
    }

    private func resolveTargetAlbumIds(sourceAlbumId: String?) -> [Int] {
        sourceAlbumId.flatMap { PhotoSyncPreferences.albumMappings[$0] }.map { [$0] } ?? []
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

        var pairs: [(PHAsset, String?)] = []
        var seen = Set<String>()

        // "Gesamte Mediathek" sentinel: enumerate every image asset directly,
        // bypassing per-album collections. Other selections are ignored when
        // the sentinel is present so the user can't accidentally double-sync.
        if albumIds.contains(PhotoSyncPreferences.allLibrarySentinel) {
            let lastSync = PhotoSyncPreferences.albumSyncDate(for: PhotoSyncPreferences.allLibrarySentinel)
            let options = buildFetchOptions(lastSync: lastSync)
            PHAsset.fetchAssets(with: .image, options: options)
                .enumerateObjects { asset, _, _ in
                    if seen.insert(asset.localIdentifier).inserted {
                        pairs.append((asset, PhotoSyncPreferences.allLibrarySentinel))
                    }
                }
        } else {
            PHAssetCollection
                .fetchAssetCollections(withLocalIdentifiers: Array(albumIds), options: nil)
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

        return pairs.map { (asset, sourceAlbumId) in
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
