import XCTest
@testable import FKPhotosLib

/// "Mit iPhone synchronisieren…" — the entry point that starts from a f4mil
/// album instead of an iOS album (issue #812). Its preconditions are the only
/// thing standing between a shared album and a link that can never work, so
/// they get covered exhaustively.
final class AlbumSyncLinkTests: XCTestCase {

    private func entry(_ id: String, _ title: String) -> IOSAlbumLocator.Entry {
        IOSAlbumLocator.Entry(localIdentifier: id, title: title)
    }

    // MARK: - The happy path

    func testUnlinkedWritableAlbumCanBeLinked() {
        let result = AlbumSyncLinkModel.precondition(
            serverAlbumId: 7,
            serverAlbumName: "Urlaub Toskana",
            hasWriteAccess: true,
            mappings: [:],
            confirmed: [],
            iosAlbums: []
        )
        XCTAssertEqual(result, .ok)
    }

    /// Ben's side of the shared-album scenario: an iOS album with the right name
    /// already exists but was never linked. It must be reused, not rejected.
    func testExistingUnlinkedIOSAlbumWithSameNameIsFine() {
        let result = AlbumSyncLinkModel.precondition(
            serverAlbumId: 7,
            serverAlbumName: "Urlaub Toskana",
            hasWriteAccess: true,
            mappings: [:],
            confirmed: [],
            iosAlbums: [entry("ios-1", "Urlaub Toskana")]
        )
        XCTAssertEqual(result, .ok)
    }

    /// Trailing whitespace is noise on the iOS side (issue #849); the same
    /// normalisation the rest of the sync uses must apply here.
    func testNameMatchingIgnoresSurroundingWhitespace() {
        let result = AlbumSyncLinkModel.precondition(
            serverAlbumId: 7,
            serverAlbumName: "Urlaub Toskana",
            hasWriteAccess: true,
            mappings: ["ios-1": 9],
            confirmed: ["ios-1"],
            iosAlbums: [entry("ios-1", "  Urlaub Toskana ")]
        )
        XCTAssertEqual(result, .nameConflict(iosAlbumTitle: "  Urlaub Toskana "))
    }

    // MARK: - Rejections

    func testReadOnlyShareIsRejected() {
        let result = AlbumSyncLinkModel.precondition(
            serverAlbumId: 7,
            serverAlbumName: "Urlaub Toskana",
            hasWriteAccess: false,
            mappings: [:],
            confirmed: [],
            iosAlbums: []
        )
        XCTAssertEqual(result, .readOnly)
    }

    func testBlankNameIsRejected() {
        let result = AlbumSyncLinkModel.precondition(
            serverAlbumId: 7,
            serverAlbumName: "   ",
            hasWriteAccess: true,
            mappings: [:],
            confirmed: [],
            iosAlbums: []
        )
        XCTAssertEqual(result, .emptyName)
    }

    func testAlreadyLinkedServerAlbumReportsItsIOSAlbum() {
        let result = AlbumSyncLinkModel.precondition(
            serverAlbumId: 7,
            serverAlbumName: "Urlaub Toskana",
            hasWriteAccess: true,
            mappings: ["ios-1": 7],
            confirmed: ["ios-1"],
            iosAlbums: [entry("ios-1", "Urlaub Toskana")]
        )
        XCTAssertEqual(result, .alreadyLinked(iosAlbumTitle: "Urlaub Toskana"))
    }

    /// A mapping the user never confirmed is not an active link, so it must not
    /// block a fresh one.
    func testUnconfirmedMappingDoesNotCountAsLinked() {
        let result = AlbumSyncLinkModel.precondition(
            serverAlbumId: 7,
            serverAlbumName: "Urlaub Toskana",
            hasWriteAccess: true,
            mappings: ["ios-1": 7],
            confirmed: [],
            iosAlbums: [entry("ios-1", "Urlaub Toskana")]
        )
        XCTAssertEqual(result, .ok)
    }

    /// Two links must never target the same iOS album — the deletion pass would
    /// reconcile it against two different server albums.
    func testSameNamedIOSAlbumLinkedElsewhereIsAConflict() {
        let result = AlbumSyncLinkModel.precondition(
            serverAlbumId: 7,
            serverAlbumName: "Urlaub Toskana",
            hasWriteAccess: true,
            mappings: ["ios-1": 42],
            confirmed: ["ios-1"],
            iosAlbums: [entry("ios-1", "Urlaub Toskana")]
        )
        XCTAssertEqual(result, .nameConflict(iosAlbumTitle: "Urlaub Toskana"))
    }

    /// A differently-named album that happens to be linked elsewhere is
    /// irrelevant — only the name we would claim matters.
    func testUnrelatedLinkedAlbumIsIgnored() {
        let result = AlbumSyncLinkModel.precondition(
            serverAlbumId: 7,
            serverAlbumName: "Urlaub Toskana",
            hasWriteAccess: true,
            mappings: ["ios-9": 42],
            confirmed: ["ios-9"],
            iosAlbums: [entry("ios-9", "Weihnachten")]
        )
        XCTAssertEqual(result, .ok)
    }

    /// Capitalisation is meaning, not noise (same rule as `AlbumName.matches`).
    func testCaseDifferenceIsNotAConflict() {
        let result = AlbumSyncLinkModel.precondition(
            serverAlbumId: 7,
            serverAlbumName: "Urlaub Toskana",
            hasWriteAccess: true,
            mappings: ["ios-1": 42],
            confirmed: ["ios-1"],
            iosAlbums: [entry("ios-1", "urlaub toskana")]
        )
        XCTAssertEqual(result, .ok)
    }

    /// Read-only is checked before everything else: no point telling the user
    /// about a name clash they can't act on until access is sorted out.
    func testReadOnlyTakesPrecedenceOverOtherProblems() {
        let result = AlbumSyncLinkModel.precondition(
            serverAlbumId: 7,
            serverAlbumName: "   ",
            hasWriteAccess: false,
            mappings: ["ios-1": 7],
            confirmed: ["ios-1"],
            iosAlbums: [entry("ios-1", "Urlaub Toskana")]
        )
        XCTAssertEqual(result, .readOnly)
    }

    // MARK: - Messages

    func testOkIsTheOnlyOutcomeWithoutAMessage() {
        XCTAssertNil(AlbumSyncLinkModel.Precondition.ok.message)
        for outcome: AlbumSyncLinkModel.Precondition in [
            .readOnly,
            .emptyName,
            .alreadyLinked(iosAlbumTitle: "A"),
            .nameConflict(iosAlbumTitle: "A"),
        ] {
            XCTAssertNotNil(outcome.message, "\(outcome) must explain itself")
        }
    }

    func testEveryModeIsOfferedWithDistinctPresentation() {
        XCTAssertEqual(PhotoSyncMode.allChoices, [.copy, .sync, .bisync])
        let titles = PhotoSyncMode.allChoices.map(\.title)
        let explanations = PhotoSyncMode.allChoices.map(\.explanation)
        XCTAssertEqual(Set(titles).count, titles.count)
        XCTAssertEqual(Set(explanations).count, explanations.count)
    }
}
