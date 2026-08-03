import Foundation
import Photos

/// Lookup and creation of *regular user* albums in the iOS photo library.
///
/// An iOS album is linked to a server album by name (issue #812), so both
/// linking directions need the same two primitives: "which user albums exist,
/// and under what title" and "give me the album with this title, creating it if
/// it doesn't exist yet".
///
/// Smart albums (Favoriten, Zuletzt, …) are deliberately never returned: their
/// membership is managed dynamically by iOS and PhotoKit forbids writing into
/// them, so linking one is unsafe — see the legacy smart-album purge in
/// `PhotoSyncService`.
enum IOSAlbumLocator {
    struct Entry: Hashable, Sendable {
        let localIdentifier: String
        let title: String
    }

    enum LocatorError: LocalizedError {
        case creationFailed

        var errorDescription: String? {
            switch self {
            case .creationFailed:
                return "Das iOS-Album konnte nicht angelegt werden."
            }
        }
    }

    /// Every regular user album, as (localIdentifier, title) pairs. Titles are
    /// returned verbatim — compare them through `AlbumName`, never directly.
    static func userAlbums() async -> [Entry] {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                var entries: [Entry] = []
                PHAssetCollection
                    .fetchAssetCollections(with: .album, subtype: .albumRegular, options: nil)
                    .enumerateObjects { collection, _, _ in
                        entries.append(
                            Entry(
                                localIdentifier: collection.localIdentifier,
                                title: collection.localizedTitle ?? ""
                            )
                        )
                    }
                continuation.resume(returning: entries)
            }
        }
    }

    /// Local identifier of the regular user album named `name`, creating the
    /// album when none exists. Name comparison goes through `AlbumName`, so an
    /// existing "Urlaub " is reused for the server album "Urlaub" instead of
    /// creating a second, space-suffixed local album (issue #849).
    static func findOrCreate(named name: String) async throws -> String {
        if let existing = await userAlbums().first(where: { AlbumName.matches($0.title, name) }) {
            return existing.localIdentifier
        }

        var createdIdentifier: String?
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges {
                let request = PHAssetCollectionChangeRequest.creationRequestForAssetCollection(
                    withTitle: AlbumName.normalized(name)
                )
                createdIdentifier = request.placeholderForCreatedAssetCollection.localIdentifier
            } completionHandler: { _, error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }

        // The placeholder identifier is only usable once the change has landed;
        // re-fetch to confirm the collection really exists before the caller
        // stores it as a permanent link target.
        guard let identifier = createdIdentifier,
              PHAssetCollection.fetchAssetCollections(
                  withLocalIdentifiers: [identifier], options: nil
              ).firstObject != nil
        else {
            throw LocatorError.creationFailed
        }
        return identifier
    }
}
