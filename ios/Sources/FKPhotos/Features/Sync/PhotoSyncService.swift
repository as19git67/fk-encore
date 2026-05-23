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
    private var currentPath: NWPath?

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            Task { await self.updatePath(path) }
        }
        monitor.start(queue: monitorQueue)
    }

    private func updatePath(_ path: NWPath) {
        currentPath = path
    }

    var isWifiConnected: Bool {
        currentPath?.usesInterfaceType(.wifi) ?? false
    }

    private var isNetworkAvailable: Bool {
        currentPath?.status == .satisfied
    }

    // MARK: - Public sync entry point

    /// Run one sync cycle. Returns silently if preconditions (enabled, auth, network) aren't met.
    func sync() async throws {
        guard PhotoSyncPreferences.syncEnabled else { return }

        if PhotoSyncPreferences.wifiOnly {
            guard isWifiConnected else { return }
        } else {
            guard isNetworkAvailable else { return }
        }

        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else { return }

        let syncStartDate = Date()

        let assets = await fetchAssets()
        guard !assets.isEmpty else {
            updateSyncDates(syncStartDate, syncedAlbumIds: [])
            return
        }

        // Step 2: Compute full-hash for each asset (PhotoHasher caches by modificationDate).
        var hashPairs: [(asset: PHAsset, filename: String, sourceAlbumId: String?, hashResult: PhotoHashResult)] = []
        for (asset, filename, sourceAlbumId) in assets {
            guard let result = await PhotoHasher.shared.hashes(for: asset) else { continue }
            hashPairs.append((asset, filename, sourceAlbumId, result))
        }

        // Step 3: Batch sync-check to find which full-hashes the server already has.
        let allFullHashes = hashPairs.map { $0.hashResult.fullHash }
        var existingHashes: Set<String> = []
        let batchSize = 5000
        for batchStart in stride(from: 0, to: allFullHashes.count, by: batchSize) {
            let slice = Array(allFullHashes[batchStart..<min(batchStart + batchSize, allFullHashes.count)])
            let serverHas = (try? await APIClient.shared.syncCheck(hashes: slice)) ?? []
            existingHashes.formUnion(serverHas)
        }

        // Step 4: Enqueue assets whose full-hash the server doesn't have into
        // the UploadQueue. Skip items already queued to avoid duplicates.
        let alreadyQueued = Set(await UploadQueue.shared.pendingItems().map(\.fullHash))

        let missing = hashPairs.filter {
            !existingHashes.contains($0.hashResult.fullHash)
            && !alreadyQueued.contains($0.hashResult.fullHash)
        }

        let batchLimit = 50
        for batchStart in stride(from: 0, to: missing.count, by: batchLimit) {
            let batch = missing[batchStart..<min(batchStart + batchLimit, missing.count)]
            for item in batch {
                let localId = item.asset.localIdentifier
                let caption = PhotoHasher.shared.captionFromAsset(item.asset) ?? ""
                let targetAlbumIds = resolveTargetAlbumIds(sourceAlbumId: item.sourceAlbumId)
                let resource = PHAssetResource.assetResources(for: item.asset)
                    .first(where: { $0.type == .photo })
                    ?? PHAssetResource.assetResources(for: item.asset).first(where: { $0.type == .fullSizePhoto })
                let mimeType = resource.map { Self.mimeType(for: $0.uniformTypeIdentifier) } ?? "image/jpeg"
                let uploadFilename = filenameMatchingMime(item.filename, mimeType: mimeType)

                let queueItem = UploadQueueItem(
                    assetLocalIdentifier: localId,
                    filename: uploadFilename,
                    mimeType: mimeType,
                    imageDataHash: item.hashResult.imageDataHash,
                    fullHash: item.hashResult.fullHash,
                    caption: caption,
                    isFavorite: item.asset.isFavorite,
                    capturedAtString: item.hashResult.capturedAtString,
                    targetAlbumIds: targetAlbumIds
                )
                await UploadQueue.shared.enqueue(queueItem)
            }
            await BackgroundSyncManager.shared.drainUploadQueue()
        }

        let syncedAlbumIds = Set(assets.compactMap { $0.2 })
        updateSyncDates(syncStartDate, syncedAlbumIds: syncedAlbumIds)
    }

    private func updateSyncDates(_ date: Date, syncedAlbumIds: Set<String>) {
        switch PhotoSyncPreferences.albumMode {
        case .all:
            PhotoSyncPreferences.lastSyncDate = date
        case .selected:
            for albumId in syncedAlbumIds {
                PhotoSyncPreferences.setAlbumSyncDate(date, for: albumId)
            }
        }
    }

    private func resolveTargetAlbumIds(sourceAlbumId: String?) -> [Int] {
        switch PhotoSyncPreferences.albumMode {
        case .all:
            return PhotoSyncPreferences.allPhotosTargetAlbumId.map { [$0] } ?? []
        case .selected:
            return sourceAlbumId.flatMap { PhotoSyncPreferences.albumMappings[$0] }.map { [$0] } ?? []
        }
    }

    // MARK: - Asset fetching

    // Dispatches to a background queue so PHFetchResult.enumerateObjects doesn't
    // block the Swift concurrency cooperative thread pool (avoids unsafeForcedSync warning).
    // Filenames are pre-fetched here so PHAssetResource.assetResources is never called
    // inside the PHImageManager completion handler (avoids main-queue metadata warning).
    // The third tuple element is the source iOS album localIdentifier (nil for .all mode).
    private func fetchAssets() async -> [(PHAsset, String, String?)] {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: Self.fetchAssetsSync())
            }
        }
    }

    private static func fetchAssetsSync() -> [(PHAsset, String, String?)] {
        var pairs: [(PHAsset, String?)] = []

        switch PhotoSyncPreferences.albumMode {
        case .all:
            let options = buildFetchOptions(lastSync: PhotoSyncPreferences.lastSyncDate)
            PHAsset.fetchAssets(with: .image, options: options)
                .enumerateObjects { asset, _, _ in pairs.append((asset, nil)) }

        case .selected:
            let albumIds = PhotoSyncPreferences.selectedAlbumIds
            guard !albumIds.isEmpty else { return [] }
            var seen = Set<String>()
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

        // Pre-fetch filenames on this background queue to avoid lazy metadata
        // fetch on the main queue inside requestImageDataAndOrientation callbacks.
        return pairs.map { (asset, sourceAlbumId) in
            let filename = PHAssetResource.assetResources(for: asset)
                .first?.originalFilename
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
        guard let resource = PHAssetResource.assetResources(for: asset)
            .first(where: { $0.type == .photo })
            ?? PHAssetResource.assetResources(for: asset).first(where: { $0.type == .fullSizePhoto })
        else {
            throw SyncError.noImageData
        }

        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true

        return try await withCheckedThrowingContinuation { continuation in
            var chunks: [Data] = []
            PHAssetResourceManager.default().requestData(for: resource, options: options) { chunk in
                chunks.append(chunk)
            } completionHandler: { error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                let data = chunks.reduce(Data(), +)
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

    /// Replace the filename's extension with one that matches *mimeType* when
    /// the two disagree. Equivalent extensions (heic ↔ heif, jpg ↔ jpeg) are
    /// considered matching and left alone so we don't churn user-recognisable
    /// names unnecessarily.
    nonisolated private func filenameMatchingMime(_ filename: String, mimeType: String) -> String {
        let expectedExt: String
        switch mimeType.lowercased() {
        case "image/heic", "image/heif": expectedExt = "heic"
        case "image/png":                expectedExt = "png"
        case "image/tiff":               expectedExt = "tiff"
        case "image/gif":                expectedExt = "gif"
        case "image/webp":               expectedExt = "webp"
        default:                         expectedExt = "jpg"
        }
        let ns = filename as NSString
        let currentExt = ns.pathExtension.lowercased()
        if currentExt == expectedExt { return filename }
        let heicLike: Set<String> = ["heic", "heif"]
        if expectedExt == "heic" && heicLike.contains(currentExt) { return filename }
        let jpegLike: Set<String> = ["jpg", "jpeg"]
        if expectedExt == "jpg" && jpegLike.contains(currentExt) { return filename }
        let stem = ns.deletingPathExtension
        return stem.isEmpty ? "photo.\(expectedExt)" : "\(stem).\(expectedExt)"
    }

    enum SyncError: LocalizedError {
        case noImageData
        var errorDescription: String? { "Keine Bilddaten verfügbar" }
    }
}
