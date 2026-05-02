import Foundation
import Photos
import Network
import ImageIO

/// Executes a download sync cycle: fetches photos from selected server albums and
/// saves them into matching iOS albums, keeping them in sync with the server.
///
/// **Sync semantics**
/// - New server photos are downloaded and added to the iOS album (same name).
/// - Photos removed from a server album are moved to the "Vivanty Trash" iOS album.
/// - Favorite status is kept up to date on every run.
/// - Description is embedded in the image's IPTC metadata on first download.
actor PhotoDownloadService {
    static let shared = PhotoDownloadService()

    static let trashAlbumName = "Vivanty Trash"

    private let monitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "dev.fk-encore.DownloadNetworkMonitor")
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

    // MARK: - Public entry point

    /// Run one download sync cycle. Returns silently if preconditions aren't met.
    func sync() async throws {
        guard DownloadSyncPreferences.downloadEnabled else { return }

        if DownloadSyncPreferences.wifiOnly {
            guard isWifiConnected else { return }
        } else {
            guard isNetworkAvailable else { return }
        }

        let albumIds = DownloadSyncPreferences.selectedServerAlbumIds
        guard !albumIds.isEmpty else { return }

        // Read/write access is required to create albums and modify existing ones
        // (needed for the trash move). If only .addOnly we skip the trash step.
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else { return }

        var downloadedPhotos = DownloadSyncPreferences.loadDownloadedPhotos()

        for albumId in albumIds {
            do {
                try await syncAlbum(albumId: albumId, downloadedPhotos: &downloadedPhotos)
            } catch {
                // Continue with remaining albums – transient errors are retried next cycle.
            }
        }

        DownloadSyncPreferences.saveDownloadedPhotos(downloadedPhotos)
        DownloadSyncPreferences.lastDownloadDate = Date()
    }

    // MARK: - Per-album sync

    private func syncAlbum(albumId: Int, downloadedPhotos: inout [String: [String: String]]) async throws {
        // Fetch and filter photos from the server
        let albumData: AlbumWithPhotos = try await APIClient.shared.get("/albums/\(albumId)")
        let serverPhotos = applyFilter(albumData.photos)

        let albumKey = String(albumId)
        var albumDownloads = downloadedPhotos[albumKey] ?? [:]

        let serverPhotoIds = Set(serverPhotos.map { String($0.id) })
        let downloadedIds  = Set(albumDownloads.keys)

        // Ensure the matching iOS album exists
        let iosAlbum   = try await getOrCreateIOSAlbum(named: albumData.name)
        let trashAlbum = try await getOrCreateIOSAlbum(named: Self.trashAlbumName)

        // 1. Remove photos that are no longer in the server album
        let removedIds = downloadedIds.subtracting(serverPhotoIds)
        for removedId in removedIds {
            if let localId = albumDownloads[removedId] {
                await moveToTrash(localIdentifier: localId, from: iosAlbum, to: trashAlbum)
                albumDownloads.removeValue(forKey: removedId)
            }
        }

        // 2. Handle photos not yet in the local download tracking
        let serverPhotoMap = PhotoSyncPreferences.loadServerPhotoMap()
        let newPhotos = serverPhotos.filter { !albumDownloads.keys.contains(String($0.id)) }
        for photo in newPhotos {
            let photoKey = String(photo.id)

            if let existingLocalId = serverPhotoMap[photoKey],
               PHAsset.fetchAssets(withLocalIdentifiers: [existingLocalId], options: nil).count > 0 {
                // This photo was originally uploaded from this device — skip the download,
                // just register it in the album tracking and update its metadata.
                albumDownloads[photoKey] = existingLocalId
                await addToAlbumIfNeeded(localIdentifier: existingLocalId, album: iosAlbum)
                await updateFavoriteStatus(localIdentifier: existingLocalId, isFavorite: photo.curation_status == .favorite)
                downloadedPhotos[albumKey] = albumDownloads
                DownloadSyncPreferences.saveDownloadedPhotos(downloadedPhotos)
            } else {
                // Not a local asset — download from server.
                do {
                    let localId = try await downloadAndSave(photo: photo, toAlbum: iosAlbum)
                    albumDownloads[photoKey] = localId
                    // Persist incrementally so a mid-run interruption doesn't re-download
                    downloadedPhotos[albumKey] = albumDownloads
                    DownloadSyncPreferences.saveDownloadedPhotos(downloadedPhotos)
                } catch {
                    // Skip individual photo failures; they'll be retried next run.
                }
            }
        }

        // 3. Update favorite status for already-downloaded photos
        let existingPhotos = serverPhotos.filter { albumDownloads.keys.contains(String($0.id)) }
        for photo in existingPhotos {
            if let localId = albumDownloads[String(photo.id)] {
                await updateFavoriteStatus(
                    localIdentifier: localId,
                    isFavorite: photo.curation_status == .favorite
                )
            }
        }

        downloadedPhotos[albumKey] = albumDownloads
    }

    // MARK: - Filter

    private func applyFilter(_ photos: [AlbumPhotoWithMeta]) -> [AlbumPhotoWithMeta] {
        let favFilter    = DownloadSyncPreferences.favoritesFilter
        let includeHidden = DownloadSyncPreferences.includeHidden

        return photos.filter { photo in
            // Hidden filter (based on the current user's curation status)
            if !includeHidden && photo.curation_status == .hidden { return false }

            switch favFilter {
            case .all:
                return true
            case .myFavorites:
                return photo.curation_status == .favorite
            case .anyFavorite:
                let myFav     = photo.curation_status == .favorite
                let othersFav = (photo.curation_stats?.fav_count ?? 0) > 0
                return myFav || othersFav
            }
        }
    }

    // MARK: - iOS photo library helpers

    private func getOrCreateIOSAlbum(named name: String) async throws -> PHAssetCollection {
        // Check whether an album with this name already exists
        let existing: PHAssetCollection? = await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                var found: PHAssetCollection?
                PHAssetCollection
                    .fetchAssetCollections(with: .album, subtype: .albumRegular, options: nil)
                    .enumerateObjects { collection, _, stop in
                        if collection.localizedTitle == name {
                            found = collection
                            stop.pointee = true
                        }
                    }
                continuation.resume(returning: found)
            }
        }
        if let album = existing { return album }

        // Create it
        var createdIdentifier: String?
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges {
                let req = PHAssetCollectionChangeRequest.creationRequestForAssetCollection(withTitle: name)
                createdIdentifier = req.placeholderForCreatedAssetCollection.localIdentifier
            } completionHandler: { _, error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }

        guard let identifier = createdIdentifier else { throw DownloadError.albumCreationFailed }
        let result = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [identifier], options: nil)
        guard let album = result.firstObject else { throw DownloadError.albumCreationFailed }
        return album
    }

    private func downloadAndSave(photo: AlbumPhotoWithMeta, toAlbum album: PHAssetCollection) async throws -> String {
        var imageData = try await APIClient.shared.downloadData("/photos/file/\(photo.filename)")

        // Best-effort: embed description into IPTC metadata before saving
        if let desc = photo.description, !desc.isEmpty {
            imageData = embedDescription(imageData, description: desc) ?? imageData
        }

        var localIdentifier: String?
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges {
                let creation = PHAssetCreationRequest.forAsset()
                creation.addResource(with: .photo, data: imageData, options: nil)
                creation.isFavorite = photo.curation_status == .favorite

                guard let placeholder = creation.placeholderForCreatedAsset,
                      let albumReq = PHAssetCollectionChangeRequest(for: album) else { return }
                albumReq.addAssets([placeholder] as NSArray)
                localIdentifier = placeholder.localIdentifier
            } completionHandler: { _, error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }

        guard let id = localIdentifier else { throw DownloadError.saveFailed }
        return id
    }

    /// Adds an existing local asset to the iOS album, if it isn't already a member.
    private func addToAlbumIfNeeded(localIdentifier: String, album: PHAssetCollection) async {
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil)
        guard assets.count > 0 else { return }

        // Check whether the asset is already in the album to avoid a redundant write.
        let inAlbum = PHAsset.fetchAssets(in: album, options: nil)
        var alreadyMember = false
        inAlbum.enumerateObjects { asset, _, stop in
            if asset.localIdentifier == localIdentifier {
                alreadyMember = true
                stop.pointee = true
            }
        }
        guard !alreadyMember else { return }

        try? await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges {
                PHAssetCollectionChangeRequest(for: album)?.addAssets(assets)
            } completionHandler: { _, error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }
    }

    private func moveToTrash(
        localIdentifier: String,
        from sourceAlbum: PHAssetCollection,
        to trashAlbum: PHAssetCollection
    ) async {
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil)
        guard assets.count > 0 else { return }

        try? await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges {
                PHAssetCollectionChangeRequest(for: sourceAlbum)?.removeAssets(assets)
                PHAssetCollectionChangeRequest(for: trashAlbum)?.addAssets(assets)
            } completionHandler: { _, error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }
    }

    private func updateFavoriteStatus(localIdentifier: String, isFavorite: Bool) async {
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil)
        guard let asset = assets.firstObject, asset.isFavorite != isFavorite else { return }

        try? await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges {
                PHAssetChangeRequest(for: asset).isFavorite = isFavorite
            } completionHandler: { _, error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }
    }

    // MARK: - IPTC description embedding

    /// Returns a copy of `data` with the IPTC caption set to `description`,
    /// or nil if the image format does not support embedded metadata.
    private func embedDescription(_ data: Data, description: String) -> Data? {
        guard
            let source = CGImageSourceCreateWithData(data as CFData, nil),
            let uti    = CGImageSourceGetType(source)
        else { return nil }

        var props = (CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]) ?? [:]
        var iptc  = props[kCGImagePropertyIPTCDictionary] as? [CFString: Any] ?? [:]
        iptc[kCGImagePropertyIPTCCaptionAbstract] = description
        props[kCGImagePropertyIPTCDictionary] = iptc

        let output = NSMutableData()
        guard
            let dest = CGImageDestinationCreateWithData(output, uti, 1, nil)
        else { return nil }
        CGImageDestinationAddImageFromSource(dest, source, 0, props as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return output as Data
    }

    // MARK: - Error types

    enum DownloadError: LocalizedError {
        case albumCreationFailed
        case saveFailed

        var errorDescription: String? {
            switch self {
            case .albumCreationFailed: return "iOS-Album konnte nicht erstellt werden"
            case .saveFailed:          return "Foto konnte nicht gespeichert werden"
            }
        }
    }
}
