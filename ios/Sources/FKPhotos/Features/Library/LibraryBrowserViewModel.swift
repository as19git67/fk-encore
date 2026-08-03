import Foundation
import Photos
import Observation

@Observable
final class LibraryBrowserViewModel {

    struct IOSAlbum: Identifiable, Hashable, Sendable {
        let id: String  // PHAssetCollection.localIdentifier
        let name: String
        let assetCount: Int
        var syncStatus: SyncStatus
        var isIndividuallySynced: Bool

        var canMakeAvailable: Bool { syncStatus == .none }
        var canDisconnect: Bool { isIndividuallySynced }

        enum SyncStatus: Hashable, Sendable {
            case none
            case copy
            case sync
            case bisync
            /// Linked, but the server album is gone or no longer writable —
            /// typically a share that was revoked or downgraded to read-only
            /// (issue #812). The engine skips such links; the user can
            /// disconnect, or the link revives on its own once access returns.
            case revoked
        }
    }

    /// How the target server album was found. Surfaced to the user because
    /// landing in *somebody else's* album is a materially different outcome from
    /// creating your own, and the name match alone doesn't make that visible
    /// (issue #812).
    enum TargetResolution: Sendable {
        case ownAlbum
        case sharedAlbum
        case created
    }

    enum MakeAvailableResult: Sendable {
        case success(
            serverAlbumId: Int,
            albumName: String,
            assetCount: Int,
            iosAlbumId: String,
            resolution: TargetResolution
        )
        case error(String)
    }

    /// Explanation shown in the mode chooser. Composed from `PhotoSyncMode` so
    /// it can't drift from the descriptions the linking sheet shows — the two
    /// used to describe the same three modes in different words ("Server-Album"
    /// here vs. "f4mil-Album" there).
    static var modeChoiceExplanation: String {
        PhotoSyncMode.allChoices
            .map { "\($0.title): \($0.explanation)" }
            .joined(separator: "\n\n")
    }

    static func status(for mode: PhotoSyncMode) -> IOSAlbum.SyncStatus {
        switch mode {
        case .copy:   return .copy
        case .sync:   return .sync
        case .bisync: return .bisync
        }
    }

    var albums: [IOSAlbum] = []
    var isLoading = true
    var authorizationDenied = false
    var isMakingAvailable = false
    var errorMessage: String?

    func load() async {
        isLoading = true
        defer { isLoading = false }

        var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .notDetermined {
            status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        }
        guard status == .authorized || status == .limited else {
            authorizationDenied = true
            return
        }

        let selectedIds = PhotoSyncPreferences.selectedAlbumIds
        let mappings = PhotoSyncPreferences.albumMappings
        let allLibrary = PhotoSyncPreferences.allLibrarySentinel
        let revoked = PhotoSyncPreferences.revokedLinkIds

        let loaded: [IOSAlbum] = await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let imageFilter = PHFetchOptions()
                imageFilter.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)

                struct Raw {
                    let collection: PHAssetCollection
                    let title: String
                    let count: Int
                }

                var seenIds = Set<String>()
                var raw: [Raw] = []

                func collect(from result: PHFetchResult<PHAssetCollection>) {
                    result.enumerateObjects { collection, _, _ in
                        guard seenIds.insert(collection.localIdentifier).inserted else { return }
                        // Empty albums are listed too: a sync can be prepared
                        // before the first photo lands in the album (issue #822).
                        let count = PHAsset.fetchAssets(in: collection, options: imageFilter).count
                        let title = collection.localizedTitle ?? "Unbekannt"
                        raw.append(Raw(collection: collection, title: title, count: count))
                    }
                }
                // Only regular user albums. Smart/system albums (Recents,
                // Favoriten, Recently Saved, …) are intentionally excluded: their
                // membership is managed dynamically by iOS and can't be safely
                // linked for sync (and PhotoKit forbids writing into them).
                collect(from: PHAssetCollection.fetchAssetCollections(with: .album, subtype: .albumRegular, options: nil))

                let isAllLibrary = selectedIds.contains(allLibrary)
                let result = raw.map { r -> IOSAlbum in
                    let localId = r.collection.localIdentifier
                    let individuallySynced = selectedIds.contains(localId) && mappings[localId] != nil
                    let status: IOSAlbum.SyncStatus
                    if individuallySynced {
                        status = revoked.contains(localId)
                            ? .revoked
                            : Self.status(for: PhotoSyncPreferences.albumSyncMode(for: localId))
                    } else if isAllLibrary {
                        status = .copy
                    } else {
                        status = .none
                    }
                    return IOSAlbum(
                        id: localId,
                        name: r.title,
                        assetCount: r.count,
                        syncStatus: status,
                        isIndividuallySynced: individuallySynced
                    )
                }
                continuation.resume(returning: result)
            }
        }

        albums = loaded.sorted { a, b in
            if a.syncStatus != .none && b.syncStatus == .none { return true }
            if a.syncStatus == .none && b.syncStatus != .none { return false }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    // MARK: - Make Available

    func makeAvailable(_ album: IOSAlbum, mode: PhotoSyncMode) async -> MakeAvailableResult {
        isMakingAvailable = true
        defer { isMakingAvailable = false }

        // Names are matched trimmed on both sides, so "Urlaub " and "Urlaub"
        // count as the same album everywhere (issue #849).
        let serverName = AlbumName.normalized(album.name)

        let duplicateLinked = albums.first {
            $0.id != album.id && AlbumName.matches($0.name, album.name) && $0.syncStatus != .none
        }
        if duplicateLinked != nil {
            return .error("Ein iPhone-Album mit dem Namen \"\(serverName)\" ist bereits verknüpft.")
        }

        let serverAlbums: [Album]
        do {
            let response: ListAlbumsResponse = try await APIClient.shared.get("/albums")
            serverAlbums = response.albums
        } catch {
            return .error("f4mil-Alben konnten nicht geladen werden: \(error.localizedDescription)")
        }

        var targetAlbumId: Int?
        var resolution: TargetResolution = .created

        if let ownAlbum = serverAlbums.first(where: {
            AlbumName.matches($0.name, serverName) && $0.my_access_level == "owner"
        }) {
            targetAlbumId = ownAlbum.id
            resolution = .ownAlbum
        } else if let sharedAlbum = serverAlbums.first(where: {
            AlbumName.matches($0.name, serverName) && $0.hasWriteAccess
        }) {
            targetAlbumId = sharedAlbum.id
            resolution = .sharedAlbum
        } else {
            struct Body: Encodable { let name: String; let description: String? }
            struct CreatedAlbum: Decodable { let id: Int }
            do {
                let created: CreatedAlbum = try await APIClient.shared.post(
                    "/albums", body: Body(name: serverName, description: nil)
                )
                targetAlbumId = created.id
            } catch {
                return .error("Album konnte nicht erstellt werden: \(error.localizedDescription)")
            }
        }

        guard let serverId = targetAlbumId else {
            return .error("Unbekannter Fehler bei der Album-Zuordnung.")
        }

        var selectedIds = PhotoSyncPreferences.selectedAlbumIds
        selectedIds.insert(album.id)
        PhotoSyncPreferences.selectedAlbumIds = selectedIds

        var mappings = PhotoSyncPreferences.albumMappings
        mappings[album.id] = serverId
        PhotoSyncPreferences.albumMappings = mappings

        PhotoSyncPreferences.confirmMapping(for: album.id)
        PhotoSyncPreferences.setAlbumSyncMode(mode, for: album.id)
        PhotoSyncPreferences.syncEnabled = true
        // Re-linking an album whose share had been revoked must un-park it,
        // otherwise the engine keeps skipping the fresh link.
        PhotoSyncPreferences.clearRevokedLink(for: album.id)

        PhotoSyncPreferences.setAlbumSyncDate(Date(), for: album.id)

        if let idx = albums.firstIndex(where: { $0.id == album.id }) {
            albums[idx].syncStatus = Self.status(for: mode)
            albums[idx].isIndividuallySynced = true
        }

        BackgroundSyncManager.shared.scheduleNextSyncIfNeeded()

        return .success(
            serverAlbumId: serverId,
            albumName: album.name,
            assetCount: album.assetCount,
            iosAlbumId: album.id,
            resolution: resolution
        )
    }

    // MARK: - Disconnect

    func disconnect(_ album: IOSAlbum) {
        var selectedIds = PhotoSyncPreferences.selectedAlbumIds
        selectedIds.remove(album.id)
        PhotoSyncPreferences.selectedAlbumIds = selectedIds

        var mappings = PhotoSyncPreferences.albumMappings
        mappings.removeValue(forKey: album.id)
        PhotoSyncPreferences.albumMappings = mappings

        PhotoSyncPreferences.unconfirmMapping(for: album.id)
        PhotoSyncPreferences.removeAlbumSyncMode(for: album.id)
        PhotoSyncPreferences.resetAlbumSyncDate(for: album.id)
        PhotoSyncPreferences.clearRevokedLink(for: album.id)

        if let idx = albums.firstIndex(where: { $0.id == album.id }) {
            albums[idx].syncStatus = .none
            albums[idx].isIndividuallySynced = false
        }
    }

    // MARK: - Change sync mode

    /// Switches an already-linked album between copy and sync mode. Switching to
    /// sync schedules a run so the deletion pass reconciles the server album
    /// with the current iOS album contents.
    func setSyncMode(_ mode: PhotoSyncMode, for album: IOSAlbum) {
        guard album.isIndividuallySynced else { return }
        PhotoSyncPreferences.setAlbumSyncMode(mode, for: album.id)
        if let idx = albums.firstIndex(where: { $0.id == album.id }) {
            albums[idx].syncStatus = Self.status(for: mode)
        }
        if mode == .sync || mode == .bisync {
            BackgroundSyncManager.shared.scheduleNextSyncIfNeeded()
        }
    }
}
