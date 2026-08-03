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

    // MARK: - Batch result feedback

    func testSinglePhotoUsesSingularWording() {
        let toast = LibraryPhotoCopySheet.resultToast(enqueued: 1, requested: 1, albumName: "Toskana")
        XCTAssertEqual(toast?.style, .success)
        XCTAssertEqual(toast?.text, "Foto wird an \"Toskana\" gesendet")
    }

    func testFullBatchUsesPluralWording() {
        let toast = LibraryPhotoCopySheet.resultToast(enqueued: 12, requested: 12, albumName: "Toskana")
        XCTAssertEqual(toast?.style, .success)
        XCTAssertEqual(toast?.text, "12 Fotos werden an \"Toskana\" gesendet")
    }

    /// Reporting the batch as complete would hide the gap until the user
    /// eventually notices missing photos — so a partial result says so out loud.
    ///
    /// This is not the iCloud-only case: the hash pipeline sets
    /// `isNetworkAccessAllowed`, so those originals are fetched and copied
    /// normally. A photo lands here when that fetch genuinely fails.
    func testPartialBatchReportsBothCounts() {
        let toast = LibraryPhotoCopySheet.resultToast(enqueued: 47, requested: 50, albumName: "Toskana")
        XCTAssertEqual(toast?.style, .info)
        XCTAssertEqual(toast?.text.contains("47 von 50"), true, toast?.text ?? "")
    }

    /// Nothing prepared is not a toast the sheet can phrase — the caller falls
    /// back to the model's own error message.
    func testNothingEnqueuedYieldsNoToast() {
        XCTAssertNil(LibraryPhotoCopySheet.resultToast(enqueued: 0, requested: 3, albumName: "Toskana"))
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
