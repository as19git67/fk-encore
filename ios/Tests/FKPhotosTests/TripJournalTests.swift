import XCTest
@testable import FKPhotosLib

/// Who changed what, as the screen reads it (§6.3).
///
/// The two things the list must not do: hide a change that was taken
/// back — the journal is what happened — and offer an undo for the one
/// operation that has no inverse.
final class TripJournalTests: XCTestCase {

    private let json = """
    { "entries": [
        { "id": 3, "kind": "hide-spot",
          "sentence": "Stadtmuseum für diese Reise ausgeblendet",
          "actor": "Anna", "at": "2026-07-12T09:14:00.000Z",
          "undoable": true, "undoneAt": null, "undoneBy": null },
        { "id": 2, "kind": "stop-to-pool",
          "sentence": "Aussichtsturm zurück in den Vorrat gelegt",
          "actor": "Papa", "at": "2026-07-12T08:02:00.000Z",
          "undoable": false, "undoneAt": null, "undoneBy": null },
        { "id": 1, "kind": "vote", "sentence": "Turm: will ich",
          "actor": "Anna", "at": "2026-07-11T20:00:00.000Z",
          "undoable": false, "undoneAt": "2026-07-12T07:00:00.000Z", "undoneBy": "Papa" }
      ] }
    """

    private func entries() throws -> [TripJournalEntry] {
        try JSONDecoder().decode(TripJournal.self, from: Data(json.utf8)).entries
    }

    func testAChangeSaysWhoMadeItAndWhen() throws {
        XCTAssertEqual(try entries()[0].byline, "Anna · 12.07.2026")
    }

    func testAChangeThatWasTakenBackStaysInTheList() throws {
        // The journal is what happened; a list that loses its mistakes
        // is a list about a trip nobody had.
        let undone = try entries()[2]

        XCTAssertNotNil(undone.undoneAt)
        XCTAssertFalse(undone.undoable)
        XCTAssertEqual(undone.byline, "Anna · 11.07.2026 · zurückgenommen von Papa")
    }

    func testTheOneChangeWithoutAnInverseSaysWhy() throws {
        // §6.3: the day was re-solved around the gap, so putting the
        // stop back would be a new decision, not a rollback.
        let poolled = try entries()[1]

        XCTAssertFalse(poolled.undoable)
        XCTAssertEqual(poolled.whyNotUndoable?.contains("neue Entscheidung"), true)
    }

    func testAnUndoableChangeOffersNoExplanationBecauseTheButtonIsThere() throws {
        XCTAssertNil(try entries()[0].whyNotUndoable)
    }
}
