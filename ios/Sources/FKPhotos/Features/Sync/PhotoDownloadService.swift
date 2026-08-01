import Foundation
import Photos
import Network
import ImageIO

/// Executes a download sync cycle: fetches photos from selected server albums and
/// saves them into matching iOS albums, keeping them in sync with the server.
///
/// **Sync semantics**
/// - New server photos are downloaded and added to the iOS album (same name).
/// - Photos removed from a server album are moved to the "F4mil Trash" iOS album.
/// - Favorite status is kept up to date on every run.
/// - Description is embedded in the image's IPTC metadata on first download.
actor PhotoDownloadService {
    static let shared = PhotoDownloadService()

    static let trashAlbumName = "F4mil Trash"

    private let monitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "dev.fk-encore.DownloadNetworkMonitor")
    private var currentPath: NWPath?
    /// Continuations waiting for the monitor's first path update. Without this
    /// the first connectivity query after launch sees `currentPath == nil` and
    /// wrongly reports "no WiFi" (same first-call race as `PhotoSyncService`).
    private var firstPathWaiters: [UUID: CheckedContinuation<Void, Never>] = [:]

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            Task { await self.updatePath(path) }
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
    /// yet, bounded by a safety timeout.
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

    var isWifiConnected: Bool {
        get async {
            await awaitFirstPath()
            return (currentPath ?? monitor.currentPath).usesInterfaceType(.wifi)
        }
    }

    private var isNetworkAvailable: Bool {
        get async {
            await awaitFirstPath()
            return (currentPath ?? monitor.currentPath).status == .satisfied
        }
    }

    // MARK: - Public entry point

    /// Run one download sync cycle. Returns silently if preconditions aren't met.
    func sync() async throws {
        // Bisync albums (issue #812 Etappe 4) are pulled even when the global
        // "Automatisch herunterladen" toggle is off — their download half is
        // implied by the two-way mode.
        let bisyncIds = PhotoSyncPreferences.bisyncServerAlbumIds()
        guard DownloadSyncPreferences.downloadEnabled || !bisyncIds.isEmpty else { return }

        if DownloadSyncPreferences.wifiOnly {
            guard await isWifiConnected else { return }
        } else {
            guard await isNetworkAvailable else { return }
        }

        let albumIds = DownloadSyncPreferences.selectedServerAlbumIds.union(bisyncIds)
        guard !albumIds.isEmpty else { return }

        // Read/write access is required to create albums and modify existing ones
        // (needed for the trash move). If only .addOnly we skip the trash step.
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else { return }

        // Fast-skip: ask /photos/index whether anything changed since the last
        // sync. A 304 means no photo was added, removed, or had its metadata
        // touched user-wide → the per-album walk has nothing to do (issue #303
        // phase 5). The first run (no stored ETag) falls through to the full
        // walk and seeds the ETag on success.
        let lastETag = DownloadSyncPreferences.lastIndexETag
        if let lastETag {
            do {
                let resp = try await APIClient.shared.getWithETag(
                    "/photos/index",
                    ifNoneMatch: lastETag,
                    query: ["limit": "1"]
                )
                if resp == nil {
                    // 304 Not Modified — nothing to do, even existing-asset
                    // metadata reconciliation is unnecessary.
                    DownloadSyncPreferences.lastDownloadDate = Date()
                    return
                }
            } catch {
                // Treat any error as "do the full walk" — better to over-sync
                // than miss a change.
            }
        }

        var downloadedPhotos = DownloadSyncPreferences.loadDownloadedPhotos()
        var downloadedState  = DownloadSyncPreferences.loadDownloadedState()

        var wasCancelled = false
        for albumId in albumIds {
            // Stop cleanly on BG-task expiry / app suspension instead of
            // burning the grace period on requests that will be aborted anyway.
            if Task.isCancelled { wasCancelled = true; break }
            do {
                try await syncAlbum(
                    albumId: albumId,
                    downloadedPhotos: &downloadedPhotos,
                    downloadedState: &downloadedState
                )
            } catch is CancellationError {
                wasCancelled = true
                break
            } catch {
                // Continue with remaining albums – transient errors are retried next cycle.
            }
        }

        // Always persist what this run achieved — also on cancellation, so the
        // next run resumes instead of re-downloading.
        DownloadSyncPreferences.saveDownloadedPhotos(downloadedPhotos)
        DownloadSyncPreferences.saveDownloadedState(downloadedState)
        if wasCancelled { throw CancellationError() }
        DownloadSyncPreferences.lastDownloadDate = Date()

        // Refresh the cached ETag so the next sync can short-circuit on 304.
        // Done unconditionally (and ignoring failures) because a stale ETag
        // only costs one extra walk; missing one would be a correctness bug.
        if let resp = try? await APIClient.shared.getWithETag(
            "/photos/index",
            ifNoneMatch: nil,
            query: ["limit": "1"]
        ), let etag = resp.etag {
            DownloadSyncPreferences.lastIndexETag = etag
        }
    }

    // MARK: - Per-album sync

    private func syncAlbum(
        albumId: Int,
        downloadedPhotos: inout [String: [String: String]],
        downloadedState: inout [String: DownloadSyncPreferences.DownloadedPhotoState]
    ) async throws {
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

        // 0. Reverse of hide→trash: a photo that is hidden server-side but whose
        //    local asset is back in the iOS album (the user pulled it out of
        //    "F4mil Trash") is pushed back to `visible`. Uses the RAW, unfiltered
        //    server list because `applyFilter` has already dropped hidden photos.
        //    The un-hidden photos only reappear as visible on the NEXT run (this
        //    run's server response still said hidden) — eventual consistency, no
        //    extra fetch. Decision core is the pure `unhideCandidates`.
        if !DownloadSyncPreferences.includeHidden {
            let hiddenIds = albumData.photos
                .filter { $0.curation_status == .hidden }
                .map { $0.id }
            if !hiddenIds.isEmpty {
                let memberLocalIds = await albumMemberLocalIds(in: iosAlbum)
                let unhideMap = PhotoSyncPreferences.loadServerPhotoMap()
                let toUnhide = Self.unhideCandidates(
                    hiddenServerPhotoIds: hiddenIds,
                    serverPhotoMap: unhideMap,
                    albumMemberLocalIds: memberLocalIds,
                    includeHidden: false
                )
                for photoId in toUnhide {
                    try Task.checkCancellation()
                    await unhideOnServer(photoId: photoId)
                }
            }
        }

        // 1. Remove photos that are no longer in the server album
        let removedIds = downloadedIds.subtracting(serverPhotoIds)
        for removedId in removedIds {
            if let localId = albumDownloads[removedId] {
                await moveToTrash(localIdentifier: localId, from: iosAlbum, to: trashAlbum)
                albumDownloads.removeValue(forKey: removedId)
                if let removedIntId = Int(removedId) {
                    downloadedState.removeValue(forKey: DownloadSyncPreferences.stateKey(albumId: albumId, photoId: removedIntId))
                }
            }
        }

        // 2. Handle photos not yet in the local download tracking
        let serverPhotoMap = PhotoSyncPreferences.loadServerPhotoMap()
        let newPhotos = serverPhotos.filter { !albumDownloads.keys.contains(String($0.id)) }
        for photo in newPhotos {
            try Task.checkCancellation()
            let photoKey = String(photo.id)

            if let existingLocalId = serverPhotoMap[photoKey],
               PHAsset.fetchAssets(withLocalIdentifiers: [existingLocalId], options: nil).count > 0 {
                // Already have a local asset for this server photo — a device
                // original we uploaded, or one this app downloaded for another
                // album. Reuse it (register + add to album + update metadata);
                // no re-download.
                albumDownloads[photoKey] = existingLocalId
                await addToAlbumIfNeeded(localIdentifier: existingLocalId, album: iosAlbum)
                await applyServerMetadata(localIdentifier: existingLocalId, photo: photo)
                downloadedState[DownloadSyncPreferences.stateKey(albumId: albumId, photoId: photo.id)] = makeState(from: photo)
                downloadedPhotos[albumKey] = albumDownloads
                DownloadSyncPreferences.saveDownloadedPhotos(downloadedPhotos)
                DownloadSyncPreferences.saveDownloadedState(downloadedState)
            } else {
                // Not a local asset — download from server.
                do {
                    let localId = try await downloadAndSave(photo: photo, toAlbum: iosAlbum)
                    albumDownloads[photoKey] = localId
                    downloadedState[DownloadSyncPreferences.stateKey(albumId: albumId, photoId: photo.id)] = makeState(from: photo)
                    // Persist incrementally so a mid-run interruption doesn't re-download
                    downloadedPhotos[albumKey] = albumDownloads
                    DownloadSyncPreferences.saveDownloadedPhotos(downloadedPhotos)
                    DownloadSyncPreferences.saveDownloadedState(downloadedState)
                } catch is CancellationError {
                    throw CancellationError()
                } catch {
                    // Skip individual photo failures; they'll be retried next run.
                }
            }
        }

        // 3. Reconcile already-downloaded photos with current server state.
        //    Skip work fast when neither hash nor updated_at moved (issue #303).
        //    Re-read after step 2 so freshly-downloaded assets are included.
        let downloadedAssetIds = DownloadSyncPreferences.loadDownloadedAssetIds()
        let existingPhotos = serverPhotos.filter { albumDownloads.keys.contains(String($0.id)) }
        for photo in existingPhotos {
            try Task.checkCancellation()
            guard let localId = albumDownloads[String(photo.id)] else { continue }
            let key = DownloadSyncPreferences.stateKey(albumId: albumId, photoId: photo.id)
            let prev = downloadedState[key]
            let next = makeState(from: photo)

            // Re-download only on a real SERVER pixel change, and only for assets
            // THIS app downloaded (app-created → deletable without a prompt, never
            // a camera original). Metadata-only changes — including caption — never
            // replace a local photo (no re-encoded duplicate). Device-originated
            // photos are never replaced; the device is their pixel source. The
            // decision core is a pure function (see `reconcileAction`) so it can
            // be unit-tested without a live Photos library.
            let isDownloaded = downloadedAssetIds.contains(localId)

            switch Self.reconcileAction(prev: prev, next: next, isDownloaded: isDownloaded) {
            case .skip:
                continue  // nothing moved

            case .replacePixels:
                // Re-download the server's new pixels (byte-identical). The old
                // app-created copy is deleted (no prompt) and the new asset takes
                // its place; the upload side skips it (downloaded-asset guard), so
                // this doesn't loop back as a server/device duplicate.
                do {
                    let newLocalId = try await replaceLocalAsset(
                        oldLocalIdentifier: localId,
                        photo: photo,
                        toAlbum: iosAlbum
                    )
                    albumDownloads[String(photo.id)] = newLocalId
                    downloadedPhotos[albumKey] = albumDownloads
                } catch is CancellationError {
                    throw CancellationError()
                } catch {
                    // Leave the old local asset in place; we'll retry next run.
                    continue
                }

            case .metadataOnly:
                // Update favorite / creationDate in place. The caption is
                // intentionally NOT written back — a camera original exposes no
                // user-editable description on iOS, so a server-side caption edit
                // stays server-only (the "web description → iOS" restriction).
                await applyServerMetadata(localIdentifier: localId, photo: photo)

            case .metadataAndCaption:
                // Downloaded (app-created) asset whose caption changed: apply
                // favorite/date AND propagate the caption via a lossless metadata
                // edit (no re-download, no pixel change, no re-upload).
                await applyServerMetadata(localIdentifier: localId, photo: photo)
                await applyCaption(localIdentifier: localId, description: photo.description)
            }

            downloadedState[key] = next
        }

        downloadedPhotos[albumKey] = albumDownloads
    }

    // MARK: - Helpers (issue #303)

    private func makeState(from photo: AlbumPhotoWithMeta) -> DownloadSyncPreferences.DownloadedPhotoState {
        DownloadSyncPreferences.DownloadedPhotoState(
            hash: photo.hash,
            imageDataHash: photo.image_data_hash,
            updatedAt: photo.updated_at,
            takenAt: photo.taken_at,
            isFavorite: photo.curation_status == .favorite,
            caption: photo.description
        )
    }

    /// What the download reconcile must do for one already-tracked album photo,
    /// given the server state we last applied (`prev`), the server state now
    /// (`next`), and whether the local asset is one THIS app downloaded.
    enum ReconcileAction: Equatable, Sendable {
        /// Server state matches what we last applied — nothing to do.
        case skip
        /// Server pixels changed AND the asset is app-downloaded → re-download.
        case replacePixels
        /// Apply favorite/date only; the caption is left untouched (camera
        /// originals: iOS exposes no user-editable description → web caption
        /// edits stay server-only).
        case metadataOnly
        /// Downloaded asset whose caption changed → apply favorite/date AND write
        /// the caption into the asset's IPTC.
        case metadataAndCaption
    }

    /// Pure reconcile decision (extracted for unit testing — no Photos library
    /// or network involved). Pixel changes are decided ONLY from
    /// `image_data_hash`, never the full/state `hash`, so a favorite/caption/date
    /// edit never triggers a re-download + delete. A nil pixel hash on either
    /// side counts as "pixels unchanged".
    nonisolated static func reconcileAction(
        prev: DownloadSyncPreferences.DownloadedPhotoState?,
        next: DownloadSyncPreferences.DownloadedPhotoState,
        isDownloaded: Bool
    ) -> ReconcileAction {
        if prev == next { return .skip }

        let pixelsChanged: Bool = {
            guard let p = prev?.imageDataHash, let n = next.imageDataHash else { return false }
            return p != n
        }()

        if pixelsChanged && isDownloaded { return .replacePixels }
        if isDownloaded && prev?.caption != next.caption { return .metadataAndCaption }
        return .metadataOnly
    }

    /// Reverse of hide→trash: which hidden server photos should be pushed back to
    /// `visible`. A photo qualifies when it is hidden server-side AND its mapped
    /// local asset is a member of the synced iOS album again — i.e. the user
    /// pulled it out of "F4mil Trash". With the hidden filter off there is no
    /// hide→trash semantics, so nothing is un-hidden. Pure (no Photos library or
    /// network) so it can be unit-tested, mirroring `computeAlbumRemovals` /
    /// `reconcileAction`.
    nonisolated static func unhideCandidates(
        hiddenServerPhotoIds: [Int],
        serverPhotoMap: [String: String],
        albumMemberLocalIds: Set<String>,
        includeHidden: Bool
    ) -> [Int] {
        guard !includeHidden else { return [] }
        return hiddenServerPhotoIds.filter { id in
            guard let localId = serverPhotoMap[String(id)] else { return false }
            return albumMemberLocalIds.contains(localId)
        }
    }

    /// Applies server-side metadata onto the local PHAsset: favorite flag and
    /// creationDate. Description / keywords are not propagated — iOS Photos
    /// doesn't expose user-editable description on PHAsset.
    private func applyServerMetadata(localIdentifier: String, photo: AlbumPhotoWithMeta) async {
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil)
        guard let asset = assets.firstObject else { return }

        let wantFav = photo.curation_status == .favorite
        let wantCreation: Date? = photo.taken_at.flatMap { ISO8601DateFormatter().date(from: $0) }

        let needsFav = asset.isFavorite != wantFav
        let needsDate = wantCreation != nil && asset.creationDate != wantCreation
        guard needsFav || needsDate else { return }

        try? await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges {
                let req = PHAssetChangeRequest(for: asset)
                if needsFav { req.isFavorite = wantFav }
                if needsDate, let d = wantCreation { req.creationDate = d }
            } completionHandler: { _, error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }
    }

    /// Writes `description` into the asset's IPTC caption **losslessly** — via a
    /// content edit that only rewrites metadata (`CGImageDestinationCopyImageSource`
    /// copies the image bytes unchanged, no re-encode). The pixels — and thus the
    /// `image_data_hash` — stay identical; only the metadata changes.
    ///
    /// Safe for downloaded assets specifically: the content edit bumps the
    /// asset's `modificationDate`, but the upload scan skips downloaded assets
    /// (round-trip guard), so this never causes a re-upload. It also never
    /// triggers a re-download — the download reconcile compares SERVER hashes,
    /// which a local edit does not touch. Must NOT be used on camera originals
    /// (those aren't upload-skipped → would re-upload, and we don't modify
    /// originals). Best-effort: any failure leaves the asset unchanged.
    private func applyCaption(localIdentifier: String, description: String?) async {
        guard let description, !description.isEmpty else { return }
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil)
        guard let asset = assets.firstObject else { return }

        let requestOptions = PHContentEditingInputRequestOptions()
        requestOptions.isNetworkAccessAllowed = true
        let input: PHContentEditingInput? = await withCheckedContinuation { cont in
            asset.requestContentEditingInput(with: requestOptions) { input, _ in
                cont.resume(returning: input)
            }
        }
        guard
            let input,
            let sourceURL = input.fullSizeImageURL,
            let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
            let uti = CGImageSourceGetType(source)
        else { return }

        // Skip if the file already carries this caption (no redundant edit).
        let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        let iptc = props?[kCGImagePropertyIPTCDictionary] as? [CFString: Any]
        if let existing = iptc?[kCGImagePropertyIPTCCaptionAbstract] as? String, existing == description {
            return
        }

        // Metadata-only change: set the IPTC caption, merge into existing metadata.
        let metadata = CGImageMetadataCreateMutable()
        guard CGImageMetadataSetValueMatchingImageProperty(
            metadata, kCGImagePropertyIPTCDictionary, kCGImagePropertyIPTCCaptionAbstract, description as CFString
        ) else { return }

        let output = PHContentEditingOutput(contentEditingInput: input)
        output.adjustmentData = PHAdjustmentData(
            formatIdentifier: "dev.fk-encore.F4milPhotos.caption",
            formatVersion: "1",
            data: Data(description.utf8)
        )

        guard let dest = CGImageDestinationCreateWithURL(output.renderedContentURL as CFURL, uti, 1, nil) else { return }
        let destOptions: [CFString: Any] = [
            kCGImageDestinationMetadata: metadata,
            kCGImageDestinationMergeMetadata: true,
        ]
        guard CGImageDestinationCopyImageSource(dest, source, destOptions as CFDictionary, nil) else { return }

        try? await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges {
                PHAssetChangeRequest(for: asset).contentEditingOutput = output
            } completionHandler: { _, error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }
    }


    /// Re-downloads `photo` and replaces the local asset identified by
    /// `oldLocalIdentifier`. The old asset is deleted (which on iOS moves it
    /// to "Recently Deleted" — recoverable for 30 days) and a new one is
    /// inserted into `album`. Returns the new local identifier.
    private func replaceLocalAsset(
        oldLocalIdentifier: String,
        photo: AlbumPhotoWithMeta,
        toAlbum album: PHAssetCollection
    ) async throws -> String {
        // Save the server's original bytes unchanged (no IPTC re-encoding) so the
        // local copy stays byte-identical to the server file — no re-encoded
        // duplicate ever replaces a photo on the device.
        let imageData = try await APIClient.shared.downloadData("/photos/file/\(photo.filename)")

        var newLocalIdentifier: String?
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges {
                // Delete the stale asset. If the asset isn't found (already removed
                // by the user) this is a no-op since fetchAssets returns empty.
                let oldAssets = PHAsset.fetchAssets(withLocalIdentifiers: [oldLocalIdentifier], options: nil)
                if oldAssets.count > 0 {
                    PHAssetChangeRequest.deleteAssets(oldAssets)
                }

                let creation = PHAssetCreationRequest.forAsset()
                creation.addResource(with: .photo, data: imageData, options: nil)
                creation.isFavorite = photo.curation_status == .favorite
                if let takenAt = photo.taken_at, let d = ISO8601DateFormatter().date(from: takenAt) {
                    creation.creationDate = d
                }

                guard let placeholder = creation.placeholderForCreatedAsset,
                      let albumReq = PHAssetCollectionChangeRequest(for: album) else { return }
                albumReq.addAssets([placeholder] as NSArray)
                newLocalIdentifier = placeholder.localIdentifier
            } completionHandler: { _, error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }

        guard let id = newLocalIdentifier else { throw DownloadError.saveFailed }
        // The old app-created copy was deleted; move the "downloaded" bookkeeping
        // and the server-photo mapping to the fresh asset.
        DownloadSyncPreferences.unmarkDownloadedAsset(oldLocalIdentifier)
        DownloadSyncPreferences.markDownloadedAsset(id)
        PhotoSyncPreferences.recordUploadedPhoto(serverPhotoId: photo.id, localIdentifier: id)
        return id
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
                        // Trimmed comparison: an iOS album titled "Urlaub " must
                        // be reused for the server album "Urlaub" instead of
                        // creating a second local album (issue #849).
                        if AlbumName.matches(collection.localizedTitle ?? "", name) {
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
                let req = PHAssetCollectionChangeRequest.creationRequestForAssetCollection(
                    withTitle: AlbumName.normalized(name)
                )
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
        // Save the server's original bytes unchanged (no re-encoding) so the base
        // pixels stay identical to the server file. The caption (if any) is added
        // afterwards as a lossless metadata-only edit (see applyCaption).
        let imageData = try await APIClient.shared.downloadData("/photos/file/\(photo.filename)")

        var localIdentifier: String?
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges {
                let creation = PHAssetCreationRequest.forAsset()
                creation.addResource(with: .photo, data: imageData, options: nil)
                creation.isFavorite = photo.curation_status == .favorite
                // Align the local asset's creationDate with the server's
                // taken_at so subsequent metadata diffs (issue #303) compare
                // apples to apples instead of always showing a delta.
                if let takenAt = photo.taken_at, let d = ISO8601DateFormatter().date(from: takenAt) {
                    creation.creationDate = d
                }

                guard let placeholder = creation.placeholderForCreatedAsset,
                      let albumReq = PHAssetCollectionChangeRequest(for: album) else { return }
                albumReq.addAssets([placeholder] as NSArray)
                localIdentifier = placeholder.localIdentifier
            } completionHandler: { _, error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }

        guard let id = localIdentifier else { throw DownloadError.saveFailed }
        // Register so this asset can later be reconciled for caption/pixel
        // changes, and so the upload side never re-uploads it (round-trip guard).
        DownloadSyncPreferences.markDownloadedAsset(id)
        PhotoSyncPreferences.recordUploadedPhoto(serverPhotoId: photo.id, localIdentifier: id)
        // Apply the caption as a lossless metadata edit (the saved bytes are the
        // server's original, so the caption is added on top without re-encoding).
        await applyCaption(localIdentifier: id, description: photo.description)
        return id
    }

    /// Adds an existing local asset to the iOS album, if it isn't already a member.
    /// All local identifiers currently in `album`. Runs the enumeration off the
    /// main actor so a large album doesn't block the sync actor.
    private func albumMemberLocalIds(in album: PHAssetCollection) async -> Set<String> {
        await withCheckedContinuation { (cont: CheckedContinuation<Set<String>, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                var ids = Set<String>()
                PHAsset.fetchAssets(in: album, options: nil).enumerateObjects { asset, _, _ in
                    ids.insert(asset.localIdentifier)
                }
                cont.resume(returning: ids)
            }
        }
    }

    /// Pushes a photo's curation back to `visible` on the server. Best-effort:
    /// a failure just retries on the next sync run.
    private func unhideOnServer(photoId: Int) async {
        struct CurationBody: Encodable { let status: String }
        do {
            let _: SuccessResponse = try await APIClient.shared.patch(
                "/photos/\(photoId)/curation",
                body: CurationBody(status: "visible")
            )
        } catch {
            // Best-effort; retried next run.
        }
    }

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
