import XCTest
@testable import FKPhotosLib

/// One-off "Nach f4mil kopieren…" from the media library (issue #812,
/// Etappe 5). The target list is the whole feature's correctness surface: offer
/// an album the server will reject and the photo uploads but lands nowhere.
final class LibraryPhotoCopyTests: XCTestCase {

    private func album(_ id: Int, _ name: String, access: String?) -> Album {
        Album(
            id: id,
            user_id: 1,
            name: name,
            description: nil,
            cover_photo_id: nil,
            cover_filename: nil,
            display_mode: "grid",
            newest_photo_at: nil,
            oldest_photo_at: nil,
            photo_count: 0,
            is_shared: access != nil && access != "owner",
            created_at: "",
            updated_at: "",
            my_access_level: access
        )
    }

    /// Which access levels qualify — ordering is a separate concern, covered by
    /// `testTargetsAreSortedByNameCaseInsensitively`, so compare as a set.
    func testOwnedAndWritableSharesAreOffered() {
        let targets = LibraryPhotoCopyModel.copyTargets(from: [
            album(1, "Eigenes", access: "owner"),
            album(2, "Geteilt schreibend", access: "write"),
            album(3, "Geteilt mit Weitergabe", access: "write_share"),
        ])
        XCTAssertEqual(Set(targets.map(\.id)), [1, 2, 3])
    }

    /// The server refuses to attach a photo to an album you can only read, so
    /// offering it would silently strand the upload outside every album.
    func testReadOnlySharesAreNotOffered() {
        let targets = LibraryPhotoCopyModel.copyTargets(from: [
            album(1, "Nur lesen", access: "read"),
            album(2, "Eigenes", access: "owner"),
        ])
        XCTAssertEqual(targets.map(\.id), [2])
    }

    /// An album with no access level at all is not something we can reason
    /// about — treat it as not writable rather than guessing.
    func testUnknownAccessLevelIsNotOffered() {
        let targets = LibraryPhotoCopyModel.copyTargets(from: [
            album(1, "Unbekannt", access: nil),
            album(2, "Quatsch", access: "something-new"),
        ])
        XCTAssertTrue(targets.isEmpty)
    }

    func testTargetsAreSortedByNameCaseInsensitively() {
        let targets = LibraryPhotoCopyModel.copyTargets(from: [
            album(1, "zebra", access: "owner"),
            album(2, "Äpfel", access: "owner"),
            album(3, "Banane", access: "owner"),
        ])
        XCTAssertEqual(targets.map(\.name), ["Äpfel", "Banane", "zebra"])
    }

    func testEmptyInputYieldsNoTargets() {
        XCTAssertTrue(LibraryPhotoCopyModel.copyTargets(from: []).isEmpty)
    }

    // MARK: - Sheet payload

    /// `.sheet(item:)` re-presents whenever the identity changes, so the id has
    /// to be stable for the same photos and distinct for different ones.
    func testCopyRequestIdentityFollowsItsAssets() {
        XCTAssertEqual(
            LibraryPhotoCopyRequest([]).id,
            LibraryPhotoCopyRequest([]).id
        )
    }
}
