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

        // Local cache avoids loading image data for assets already known to be uploaded.
        // The server is the authoritative source: a 409 response means the photo exists
        // server-side (e.g. uploaded from another device) and is treated as success.
        var uploadedIds = PhotoSyncPreferences.loadUploadedIds()
        var syncedFavoriteIds = PhotoSyncPreferences.syncedFavoriteLocalIds
        var syncedTakenAt = PhotoSyncPreferences.loadSyncedTakenAt()
        var syncedModDate = PhotoSyncPreferences.loadSyncedModificationDate()

        for (asset, filename, sourceAlbumId) in assets {
            guard !uploadedIds.contains(asset.localIdentifier) else { continue }

            do {
                let (data, mimeType) = try await loadAssetData(asset, filename: filename)
                // PHAssetResource.originalFilename keeps the .HEIC extension even
                // when the asset was edited and PhotoKit re-renders the bytes as
                // JPEG (issue #333). Realign the extension with the mimeType the
                // server actually receives so downstream callers don't try to run
                // heic-convert on JPEG bytes.
                let uploadFilename = filenameMatchingMime(filename, mimeType: mimeType)
                let uploaded = try await APIClient.shared.uploadPhoto(data: data, filename: uploadFilename, mimeType: mimeType, isFavorite: asset.isFavorite, capturedAt: asset.creationDate)
                uploadedIds.insert(asset.localIdentifier)
                PhotoSyncPreferences.saveUploadedIds(uploadedIds)
                PhotoSyncPreferences.recordUploadedPhoto(serverPhotoId: uploaded.id, localIdentifier: asset.localIdentifier)
                // Track the favourite state that was sent with this upload so that
                // syncFavoriteChanges() can detect future changes.
                if asset.isFavorite {
                    syncedFavoriteIds.insert(asset.localIdentifier)
                } else {
                    syncedFavoriteIds.remove(asset.localIdentifier)
                }
                PhotoSyncPreferences.syncedFavoriteLocalIds = syncedFavoriteIds
                rememberSyncedMetadata(
                    asset: asset,
                    syncedTakenAt: &syncedTakenAt,
                    syncedModDate: &syncedModDate
                )
                await addToTargetAlbum(photoId: uploaded.id, sourceAlbumId: sourceAlbumId)
            } catch APIError.duplicatePhoto(let existingPhotoId) {
                // Server already has this photo (same SHA256 hash). Still attach
                // the existing record to the target album so the user gets the
                // expected sync outcome, then mark locally to skip next cycle.
                uploadedIds.insert(asset.localIdentifier)
                PhotoSyncPreferences.saveUploadedIds(uploadedIds)
                if let existingPhotoId {
                    PhotoSyncPreferences.recordUploadedPhoto(serverPhotoId: existingPhotoId, localIdentifier: asset.localIdentifier)
                    // The server merged any new metadata our upload carried (Phase 1
                    // of #303); also send any iOS-side edits that aren't yet reflected.
                    await propagateMetadataChanges(
                        asset: asset,
                        serverId: existingPhotoId,
                        syncedTakenAt: &syncedTakenAt,
                        syncedModDate: &syncedModDate
                    )
                    await addToTargetAlbum(photoId: existingPhotoId, sourceAlbumId: sourceAlbumId)
                }
                rememberSyncedMetadata(
                    asset: asset,
                    syncedTakenAt: &syncedTakenAt,
                    syncedModDate: &syncedModDate
                )
            } catch {
                // Transient error – asset will be retried on the next sync cycle.
            }
        }

        PhotoSyncPreferences.saveSyncedTakenAt(syncedTakenAt)
        PhotoSyncPreferences.saveSyncedModificationDate(syncedModDate)

        // Propagate favourite-status changes for photos that were already uploaded
        // in a previous sync cycle. Since uploaded photos are skipped above, this is
        // the only mechanism that keeps the server in sync with late iOS favourite
        // changes (user marks/unmarks a photo as favourite after it was uploaded).
        await syncFavoriteChanges()

        // Propagate creationDate / modificationDate edits made in iOS Photos.app
        // after the photo was already uploaded. Walks the full set of known
        // local→server mappings, not just the newly fetched assets, because
        // `onlyNew` filters by creationDate and would skip historical photos
        // the user edited later (issue #303).
        await syncMetadataChanges()

        PhotoSyncPreferences.lastSyncDate = Date()
    }

    // MARK: - Metadata change propagation (issue #303)

    /// Look up the server photo ID for a local PHAsset identifier, if known.
    private func serverIdFor(localIdentifier: String) -> Int? {
        let map = PhotoSyncPreferences.loadServerPhotoMap()
        for (serverIdStr, localId) in map where localId == localIdentifier {
            if let id = Int(serverIdStr) { return id }
        }
        return nil
    }

    /// Compares the current iOS metadata of an already-uploaded asset against
    /// the values last sent to the server. When something moved we PATCH the
    /// server with the diff. Three signals trigger a check:
    ///   - creationDate changed → PATCH /photos/:id/date
    ///   - isFavorite flipped → PATCH /photos/:id/curation (handled by
    ///     syncFavoriteChanges later in the run; we just record state here)
    ///   - modificationDate moved past the last-recorded value → asset was
    ///     edited in Photos.app; we still rely on the user to re-share if
    ///     pixel data changed, but creationDate edits are caught.
    private func propagateMetadataChanges(
        asset: PHAsset,
        serverId: Int,
        syncedTakenAt: inout [String: String],
        syncedModDate: inout [String: String]
    ) async {
        let localId = asset.localIdentifier

        // creationDate diff
        if let creation = asset.creationDate {
            let isoCreation = ISO8601DateFormatter().string(from: creation)
            if syncedTakenAt[localId] != isoCreation {
                struct DateBody: Encodable { let taken_at: String }
                struct DateResponse: Decodable { let success: Bool }
                do {
                    _ = try await APIClient.shared.patch(
                        "/photos/\(serverId)/date",
                        body: DateBody(taken_at: isoCreation)
                    ) as DateResponse
                    syncedTakenAt[localId] = isoCreation
                } catch {
                    // Skip individual failures; will be retried next cycle.
                }
            }
        }

        // Bookkeeping: remember the modificationDate so a subsequent change
        // can be detected even when creationDate didn't move (e.g. user only
        // changed the description).
        if let mod = asset.modificationDate {
            syncedModDate[localId] = ISO8601DateFormatter().string(from: mod)
        }
    }

    /// Records the sync-state baseline for an asset that was just uploaded
    /// (or where we just discovered the server already has it).
    private func rememberSyncedMetadata(
        asset: PHAsset,
        syncedTakenAt: inout [String: String],
        syncedModDate: inout [String: String]
    ) {
        let localId = asset.localIdentifier
        if let creation = asset.creationDate {
            syncedTakenAt[localId] = ISO8601DateFormatter().string(from: creation)
        }
        if let mod = asset.modificationDate {
            syncedModDate[localId] = ISO8601DateFormatter().string(from: mod)
        }
    }

    /// Walk every locally-tracked uploaded asset, look at its current PHAsset
    /// metadata and PATCH the server when something moved since we last
    /// synced. Mirrors the structure of syncFavoriteChanges() but covers
    /// creationDate (taken_at). Description / keywords aren't propagated
    /// here because PHAsset doesn't expose them — the user must re-share the
    /// photo for the embedded IPTC caption to reach the server.
    private func syncMetadataChanges() async {
        let serverPhotoMap = PhotoSyncPreferences.loadServerPhotoMap()
        guard !serverPhotoMap.isEmpty else { return }

        var localToServerId: [String: Int] = [:]
        for (serverIdStr, localId) in serverPhotoMap {
            if let serverId = Int(serverIdStr) {
                localToServerId[localId] = serverId
            }
        }
        guard !localToServerId.isEmpty else { return }

        let localIds = Array(localToServerId.keys)
        let assetsByLocalId: [String: PHAsset] = await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                var result: [String: PHAsset] = [:]
                PHAsset.fetchAssets(withLocalIdentifiers: localIds, options: nil)
                    .enumerateObjects { asset, _, _ in
                        result[asset.localIdentifier] = asset
                    }
                continuation.resume(returning: result)
            }
        }

        var syncedTakenAt = PhotoSyncPreferences.loadSyncedTakenAt()
        var syncedModDate = PhotoSyncPreferences.loadSyncedModificationDate()
        var changed = false

        for (localId, serverId) in localToServerId {
            guard let asset = assetsByLocalId[localId] else { continue }

            let prevModIso = syncedModDate[localId]
            let currentModIso = asset.modificationDate.map { ISO8601DateFormatter().string(from: $0) }
            // No modification recorded yet → seed the baseline so we can
            // detect future edits without sending a needless first PATCH.
            if prevModIso == nil {
                if let isoMod = currentModIso {
                    syncedModDate[localId] = isoMod
                    changed = true
                }
                if let creation = asset.creationDate {
                    syncedTakenAt[localId] = ISO8601DateFormatter().string(from: creation)
                    changed = true
                }
                continue
            }

            // Optimisation: when modificationDate hasn't moved we know nothing
            // could have changed in iOS Photos (the system bumps it on any edit
            // including metadata-only ones).
            if currentModIso == prevModIso { continue }

            await propagateMetadataChanges(
                asset: asset,
                serverId: serverId,
                syncedTakenAt: &syncedTakenAt,
                syncedModDate: &syncedModDate
            )
            changed = true
        }

        if changed {
            PhotoSyncPreferences.saveSyncedTakenAt(syncedTakenAt)
            PhotoSyncPreferences.saveSyncedModificationDate(syncedModDate)
        }
    }

    // MARK: - Favourite change propagation

    /// Compares the current iOS favourite state of all previously-uploaded photos
    /// against the last-known server state and sends PATCH /photos/:id/curation
    /// for every photo whose state has changed.
    private func syncFavoriteChanges() async {
        // serverPhotoMap: serverPhotoId(String) → localIdentifier(String)
        let serverPhotoMap = PhotoSyncPreferences.loadServerPhotoMap()
        guard !serverPhotoMap.isEmpty else { return }

        // Build the reverse index: localIdentifier → serverPhotoId
        var localToServerId: [String: Int] = [:]
        for (serverIdStr, localId) in serverPhotoMap {
            if let serverId = Int(serverIdStr) {
                localToServerId[localId] = serverId
            }
        }
        guard !localToServerId.isEmpty else { return }

        // Fetch the current iOS favourite flag for all uploaded assets in one pass.
        let localIds = Array(localToServerId.keys)
        let currentFavorites: [String: Bool] = await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                var result: [String: Bool] = [:]
                PHAsset.fetchAssets(withLocalIdentifiers: localIds, options: nil)
                    .enumerateObjects { asset, _, _ in
                        result[asset.localIdentifier] = asset.isFavorite
                    }
                continuation.resume(returning: result)
            }
        }

        var syncedFavoriteIds = PhotoSyncPreferences.syncedFavoriteLocalIds
        var changed = false

        struct CurationBody: Encodable { let status: String }
        struct CurationResponse: Decodable { let success: Bool }

        for (localId, serverId) in localToServerId {
            guard let currentFav = currentFavorites[localId] else { continue }
            let wasSynced = syncedFavoriteIds.contains(localId)

            if currentFav && !wasSynced {
                // Newly marked as favourite in iOS → update server
                do {
                    _ = try await APIClient.shared.patch(
                        "/photos/\(serverId)/curation",
                        body: CurationBody(status: "favorite")
                    ) as CurationResponse
                    syncedFavoriteIds.insert(localId)
                    changed = true
                } catch {
                    // Skip individual failures; will be retried on the next sync cycle.
                }
            } else if !currentFav && wasSynced {
                // Favourite removed in iOS → revert to visible on server
                do {
                    _ = try await APIClient.shared.patch(
                        "/photos/\(serverId)/curation",
                        body: CurationBody(status: "visible")
                    ) as CurationResponse
                    syncedFavoriteIds.remove(localId)
                    changed = true
                } catch {
                    // Skip individual failures; will be retried on the next sync cycle.
                }
            }
        }

        if changed {
            PhotoSyncPreferences.syncedFavoriteLocalIds = syncedFavoriteIds
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
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        options.includeHiddenAssets = false

        var predicates: [NSPredicate] = []
        if PhotoSyncPreferences.onlyNew, let lastSync = PhotoSyncPreferences.lastSyncDate {
            predicates.append(NSPredicate(format: "creationDate > %@", lastSync as NSDate))
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
        default:                         expectedExt = "jpg"  // image/jpeg + Fallback
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
