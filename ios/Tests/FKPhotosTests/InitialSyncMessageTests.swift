import XCTest
@testable import FKPhotosLib

/// "Verfügbar machen" silently matches an album somebody else shared with you
/// when the names line up (own → shared → create). That is the intended
/// behaviour, but the user has to be told: uploading into a shared album makes
/// the photos visible to everyone it is shared with (issue #812).
final class InitialSyncMessageTests: XCTestCase {

    private func pending(
        albumName: String = "Urlaub Toskana",
        assetCount: Int,
        joinedShared: Bool
    ) -> LibraryBrowserView.PendingInitialSync {
        LibraryBrowserView.PendingInitialSync(
            iosAlbumId: "ios-1",
            albumName: albumName,
            assetCount: assetCount,
            joinedSharedAlbum: joinedShared
        )
    }

    func testJoiningASharedAlbumIsSpelledOut() {
        let message = LibraryBrowserView.initialSyncPrompt(
            for: pending(assetCount: 12, joinedShared: true)
        )
        XCTAssertTrue(message.contains("geteilten Album"), message)
        XCTAssertTrue(message.contains("Urlaub Toskana"), message)
        XCTAssertTrue(message.contains("sichtbar"), message)
        // The scope question still has to be asked.
        XCTAssertTrue(message.contains("12"), message)
    }

    func testOwnAlbumGetsNoSharingWarning() {
        let message = LibraryBrowserView.initialSyncPrompt(
            for: pending(assetCount: 12, joinedShared: false)
        )
        XCTAssertFalse(message.contains("geteilten Album"), message)
        XCTAssertTrue(message.contains("12"), message)
    }

    /// An empty album asks a differently-worded question (issue #822) — the
    /// sharing note has to survive that branch too.
    func testEmptySharedAlbumKeepsBothTheNoteAndTheEmptyWording() {
        let message = LibraryBrowserView.initialSyncPrompt(
            for: pending(assetCount: 0, joinedShared: true)
        )
        XCTAssertTrue(message.contains("geteilten Album"), message)
        XCTAssertTrue(message.contains("noch leer"), message)
    }

    func testEmptyOwnAlbumAsksTheEmptyQuestionOnly() {
        let message = LibraryBrowserView.initialSyncPrompt(
            for: pending(assetCount: 0, joinedShared: false)
        )
        XCTAssertFalse(message.contains("geteilten Album"), message)
        XCTAssertTrue(message.contains("noch leer"), message)
    }

    /// The note names the album, and it must use the same trimmed form the link
    /// itself uses — otherwise it would quote a name that exists nowhere.
    func testNoteQuotesTheNormalisedAlbumName() {
        let message = LibraryBrowserView.initialSyncPrompt(
            for: pending(albumName: "  Urlaub Toskana  ", assetCount: 3, joinedShared: true)
        )
        XCTAssertTrue(message.contains("\"Urlaub Toskana\""), message)
    }
}
