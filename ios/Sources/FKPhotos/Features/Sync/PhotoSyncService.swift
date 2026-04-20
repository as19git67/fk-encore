import Foundation
import Photos
import Network

/// Executes a photo sync cycle: reads from the iOS Photos library and
/// uploads assets to the server according to the current preferences.
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

        // Don't prompt here – auth should be requested from the Settings UI
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else { return }

        let assets = await fetchAssets()
        guard !assets.isEmpty else {
            PhotoSyncPreferences.lastSyncDate = Date()
            return
        }

        // Local cache avoids loading image data for assets already known to be uploaded.
        // The server is the authoritative source: a 409 response means the photo exists
        // server-side (e.g. uploaded from another device) and is treated as success.
        var uploadedIds = PhotoSyncPreferences.loadUploadedIds()

        for (asset, filename, sourceAlbumId) in assets {
            guard !uploadedIds.contains(asset.localIdentifier) else { continue }

            do {
                let (data, mimeType) = try await loadAssetData(asset, filename: filename)
                let uploaded = try await APIClient.shared.uploadPhoto(data: data, filename: filename, mimeType: mimeType, isFavorite: asset.isFavorite)
                uploadedIds.insert(asset.localIdentifier)
                PhotoSyncPreferences.saveUploadedIds(uploadedIds)
                await addToTargetAlbum(photoId: uploaded.id, sourceAlbumId: sourceAlbumId)
            } catch APIError.httpError(409, _) {
                // Server already has this photo (same SHA256 hash) – mark locally so we
                // don't load its data again on the next cycle.
                uploadedIds.insert(asset.localIdentifier)
                PhotoSyncPreferences.saveUploadedIds(uploadedIds)
            } catch {
                // Transient error – asset will be retried on the next sync cycle.
            }
        }

        PhotoSyncPreferences.lastSyncDate = Date()
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
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        options.includeHiddenAssets = false

        if PhotoSyncPreferences.onlyNew, let lastSync = PhotoSyncPreferences.lastSyncDate {
            options.predicate = NSPredicate(format: "creationDate > %@", lastSync as NSDate)
        }

        var pairs: [(PHAsset, String?)] = []  // (asset, source iOS album ID)
        switch PhotoSyncPreferences.albumMode {
        case .all:
            PHAsset.fetchAssets(with: .image, options: options)
                .enumerateObjects { asset, _, _ in pairs.append((asset, nil)) }

        case .selected:
            let albumIds = PhotoSyncPreferences.selectedAlbumIds
            guard !albumIds.isEmpty else { return [] }
            var seen = Set<String>()
            PHAssetCollection
                .fetchAssetCollections(withLocalIdentifiers: Array(albumIds), options: nil)
                .enumerateObjects { collection, _, _ in
                    PHAsset.fetchAssets(in: collection, options: options)
                        .enumerateObjects { asset, _, _ in
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

    // MARK: - Album association

    private func addToTargetAlbum(photoId: Int, sourceAlbumId: String?) async {
        let targetAlbumId: Int?
        switch PhotoSyncPreferences.albumMode {
        case .all:
            targetAlbumId = PhotoSyncPreferences.allPhotosTargetAlbumId
        case .selected:
            targetAlbumId = sourceAlbumId.flatMap { PhotoSyncPreferences.albumMappings[$0] }
        }
        guard let albumId = targetAlbumId else { return }

        struct Body: Encodable { let albumId: Int; let photoId: Int }
        struct Response: Decodable { let success: Bool }
        _ = try? await APIClient.shared.post("/albums/photos", body: Body(albumId: albumId, photoId: photoId)) as Response
    }

    // MARK: - Asset data loading

    private func loadAssetData(_ asset: PHAsset, filename: String) async throws -> (Data, String) {
        try await withCheckedThrowingContinuation { continuation in
            let options = PHImageRequestOptions()
            options.isNetworkAccessAllowed = true   // Allow iCloud download
            options.deliveryMode = .highQualityFormat
            options.version = .current  // include edits; unedited HEIC stays HEIC, edited renders as JPEG
            options.isSynchronous = false

            PHImageManager.default().requestImageDataAndOrientation(
                for: asset, options: options
            ) { data, uti, _, info in
                if let error = info?[PHImageErrorKey] as? Error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let data else {
                    continuation.resume(throwing: SyncError.noImageData)
                    return
                }

                let mimeType: String
                if let uti {
                    if uti.contains("heic") || uti.contains("heif") { mimeType = "image/heic" }
                    else if uti.contains("png")                      { mimeType = "image/png" }
                    else if uti.contains("tiff")                     { mimeType = "image/tiff" }
                    else                                             { mimeType = "image/jpeg" }
                } else {
                    mimeType = "image/jpeg"
                }

                continuation.resume(returning: (data, mimeType))
            }
        }
    }

    enum SyncError: LocalizedError {
        case noImageData
        var errorDescription: String? { "Keine Bilddaten verfügbar" }
    }
}
