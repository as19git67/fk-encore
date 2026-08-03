import Foundation
import Photos
import Observation

/// "Mit iPhone synchronisieren…" — the mirror image of the media library's
/// "Verfügbar machen" (issue #812).
///
/// The library-side flow starts from an iOS album and finds (or creates) the
/// server album. This one starts from a **server** album — which is what you
/// have when somebody shares an album with you — and finds (or creates) the iOS
/// album. Both end in exactly the same stored relationship, so everything
/// downstream (upload scan, deletion reconciliation, bisync download half) is
/// unchanged and needs no knowledge of which direction set it up.
///
/// The shared-album case is the reason this exists: Ben has write access to
/// Anna's "Urlaub Toskana" and wants his own Toskana photos in it. Starting from
/// the iOS side would have forced him to first rename a local album to match.
@Observable
final class AlbumSyncLinkModel {

    /// Why a link can't be established. Every case is a user-fixable situation,
    /// so each one carries what the UI needs to say what to do about it.
    enum Precondition: Equatable {
        case ok
        /// Read-only share: uploads would 403 on every photo. Two-way and sync
        /// mode need write access, and a pure download relationship is what
        /// bisync on a writable album already provides.
        case readOnly
        /// This server album already has an iOS album linked to it.
        case alreadyLinked(iosAlbumTitle: String)
        /// An iOS album with the same name is linked to a *different* server
        /// album. Linking anyway would make two links fight over one album.
        case nameConflict(iosAlbumTitle: String)
        /// Album names are the link, so a blank one can't be matched.
        case emptyName

        var message: String? {
            switch self {
            case .ok:
                return nil
            case .readOnly:
                return "Für dieses Album hast du nur Leserechte. Bitte die Besitzerin oder den Besitzer um Bearbeiten-Freigabe."
            case .alreadyLinked(let title):
                return "Dieses Album ist bereits mit dem iOS-Album \"\(title)\" verknüpft."
            case .nameConflict(let title):
                return "Das iOS-Album \"\(title)\" ist bereits mit einem anderen f4mil-Album verknüpft. Benenne eines der beiden um."
            case .emptyName:
                return "Das Album hat keinen Namen — die Verknüpfung läuft über den Albumnamen."
            }
        }
    }

    enum LinkResult: Equatable {
        /// `assetCount` is the iOS album's current photo count, so the caller can
        /// ask the same "upload everything or only new ones?" question the
        /// library-side flow asks.
        case success(iosAlbumId: String, albumName: String, assetCount: Int)
        case error(String)
    }

    var isLinking = false

    /// Pure decision core (extracted for unit testing): may `serverAlbum` be
    /// linked, given the currently configured links and the iOS albums that
    /// exist?
    ///
    /// `iosAlbums` is passed in rather than read from PhotoKit so this stays a
    /// pure function — the caller does the (async, permission-gated) lookup.
    static func precondition(
        serverAlbumId: Int,
        serverAlbumName: String,
        hasWriteAccess: Bool,
        mappings: [String: Int],
        confirmed: Set<String>,
        iosAlbums: [IOSAlbumLocator.Entry]
    ) -> Precondition {
        guard hasWriteAccess else { return .readOnly }

        let name = AlbumName.normalized(serverAlbumName)
        guard !name.isEmpty else { return .emptyName }

        if let existing = mappings.first(where: { $0.value == serverAlbumId && confirmed.contains($0.key) }) {
            let title = iosAlbums.first { $0.localIdentifier == existing.key }?.title ?? name
            return .alreadyLinked(iosAlbumTitle: title)
        }

        for entry in iosAlbums where AlbumName.matches(entry.title, name) {
            guard confirmed.contains(entry.localIdentifier),
                  let mapped = mappings[entry.localIdentifier],
                  mapped != serverAlbumId
            else { continue }
            return .nameConflict(iosAlbumTitle: entry.title)
        }

        return .ok
    }

    /// Establishes the relationship: finds or creates the matching iOS album and
    /// stores exactly the same link the library-side "Verfügbar machen" writes.
    ///
    /// The per-album watermark is set to *now*, so the default is "only new
    /// photos from here on" — the caller offers the "upload everything" option
    /// afterwards, which simply resets the watermark.
    /// - Parameter hasWriteAccess: passed in rather than read off `album`,
    ///   because the album *detail* endpoint reports access as a coarse `role`
    ///   ("contributor", "admin") that `Album.hasWriteAccess` does not
    ///   recognise. The caller already resolved the question for its menu
    ///   gating; re-deriving it here would reject writers the UI let through.
    func link(album: Album, hasWriteAccess: Bool, mode: PhotoSyncMode) async -> LinkResult {
        isLinking = true
        defer { isLinking = false }

        // Creating an album and adding assets both need read-write access;
        // add-only is not enough.
        var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .notDetermined {
            status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        }
        guard status == .authorized || status == .limited else {
            return .error("Kein Zugriff auf die Fotos-Mediathek. Bitte in den Einstellungen erlauben.")
        }

        let iosAlbums = await IOSAlbumLocator.userAlbums()
        let check = Self.precondition(
            serverAlbumId: album.id,
            serverAlbumName: album.name,
            hasWriteAccess: hasWriteAccess,
            mappings: PhotoSyncPreferences.albumMappings,
            confirmed: PhotoSyncPreferences.confirmedMappingIds,
            iosAlbums: iosAlbums
        )
        if let message = check.message { return .error(message) }

        let name = AlbumName.normalized(album.name)
        let iosAlbumId: String
        do {
            iosAlbumId = try await IOSAlbumLocator.findOrCreate(named: name)
        } catch {
            return .error(error.localizedDescription)
        }

        var selected = PhotoSyncPreferences.selectedAlbumIds
        selected.insert(iosAlbumId)
        PhotoSyncPreferences.selectedAlbumIds = selected

        var mappings = PhotoSyncPreferences.albumMappings
        mappings[iosAlbumId] = album.id
        PhotoSyncPreferences.albumMappings = mappings

        PhotoSyncPreferences.confirmMapping(for: iosAlbumId)
        PhotoSyncPreferences.setAlbumSyncMode(mode, for: iosAlbumId)
        PhotoSyncPreferences.syncEnabled = true
        // Re-linking an album whose share had been revoked must clear the park
        // flag, otherwise the engine keeps skipping the fresh link.
        PhotoSyncPreferences.clearRevokedLink(for: iosAlbumId)
        PhotoSyncPreferences.setAlbumSyncDate(Date(), for: iosAlbumId)

        BackgroundSyncManager.shared.scheduleNextSyncIfNeeded()

        let assetCount = await Self.assetCount(iosAlbumId: iosAlbumId)
        return .success(iosAlbumId: iosAlbumId, albumName: name, assetCount: assetCount)
    }

    private static func assetCount(iosAlbumId: String) async -> Int {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let collections = PHAssetCollection.fetchAssetCollections(
                    withLocalIdentifiers: [iosAlbumId], options: nil
                )
                guard let collection = collections.firstObject else {
                    continuation.resume(returning: 0)
                    return
                }
                let options = PHFetchOptions()
                options.predicate = NSPredicate(
                    format: "mediaType == %d", PHAssetMediaType.image.rawValue
                )
                continuation.resume(
                    returning: PHAsset.fetchAssets(in: collection, options: options).count
                )
            }
        }
    }
}
