import XCTest
@testable import FKPhotosLib

/// The idea collection on screen (§20).
///
/// What is worth pinning down here is not the list but the wording:
/// three answers the server gives are easy to smooth over, and all
/// three matter to somebody who just tapped "merken" — it folded into
/// an entry that was already there, the map does not know the place, or
/// somebody else put it in the collection.
final class TripIdeasTests: XCTestCase {

    private func idea(_ json: String) throws -> TripIdea {
        try JSONDecoder().decode(TripIdea.self, from: Data(json.utf8))
    }

    private let full = """
    { "id": 7, "osmRef": "way:42", "name": "Biergarten Mühlinsel", "title": null,
      "lat": 48.1, "lon": 11.5, "category": "food", "dwellMinutes": 60,
      "note": null, "sourceUrl": null, "unmatched": false,
      "validFrom": null, "validTo": null, "addedBy": "Anna",
      "addedAt": "2026-09-01T10:00:00Z" }
    """

    func testTheFamilysNameWinsOverTheMaps() throws {
        let renamed = try idea("""
        { "id": 8, "osmRef": "way:43", "name": "Gaststätte Zur Post", "title": "Unser Biergarten",
          "lat": 48.1, "lon": 11.5, "category": "food", "dwellMinutes": 60,
          "note": null, "sourceUrl": null, "unmatched": false,
          "validFrom": null, "validTo": null, "addedBy": null,
          "addedAt": "2026-09-01T10:00:00Z" }
        """)
        XCTAssertEqual(renamed.displayName, "Unser Biergarten")
    }

    func testAPlaceWithoutAnyNameIsNotLeftBlank() throws {
        let nameless = try idea("""
        { "id": 9, "osmRef": "manual:1", "name": null, "title": null,
          "lat": 48.1, "lon": 11.5, "category": "sight", "dwellMinutes": 30,
          "note": null, "sourceUrl": null, "unmatched": true,
          "validFrom": null, "validTo": null, "addedBy": null,
          "addedAt": "2026-09-01T10:00:00Z" }
        """)
        XCTAssertEqual(nameless.displayName, "Unbenannter Ort")
        XCTAssertTrue(nameless.unmatched)
    }

    func testWhoCollectedItSurvivesWhenThereIsNoNote() throws {
        XCTAssertEqual(try idea(full).subtitle, "von Anna")
    }

    func testAWrittenNoteBeatsTheDerivedLine() throws {
        let noted = try idea("""
        { "id": 10, "osmRef": "way:44", "name": "Burgruine", "title": null,
          "lat": 48.1, "lon": 11.5, "category": "sight", "dwellMinutes": 45,
          "note": "Papa wollte da hin", "sourceUrl": null, "unmatched": false,
          "validFrom": null, "validTo": null, "addedBy": "Papa",
          "addedAt": "2026-09-01T10:00:00Z" }
        """)
        XCTAssertEqual(noted.subtitle, "Papa wollte da hin")
    }

    func testAnEntryWithNothingToSayGetsNoSecondLine() throws {
        let bare = try idea("""
        { "id": 11, "osmRef": "way:45", "name": "Stadtpark", "title": null,
          "lat": 48.1, "lon": 11.5, "category": "outdoors", "dwellMinutes": 45,
          "note": "   ", "sourceUrl": null, "unmatched": false,
          "validFrom": null, "validTo": null, "addedBy": null,
          "addedAt": "2026-09-01T10:00:00Z" }
        """)
        XCTAssertNil(bare.subtitle)
    }

    // MARK: - What the screen says after an addition

    private func response(merged: Bool, unknown: [String]) throws -> TripIdeaAddResponse {
        let entry = try idea(full)
        return TripIdeaAddResponse(
            entry: entry,
            merged: merged,
            matchedOsmRef: entry.osmRef,
            unknown: unknown,
        )
    }

    func testAMergeIsSaidOutLoud() throws {
        // Otherwise the list does not grow and somebody who just tapped
        // "merken" reads that as a failure.
        let sentence = TripIdeasViewModel.sentence(for: try response(merged: true, unknown: []))
        XCTAssertTrue(sentence.contains("war schon im Vorrat"))
    }

    func testANewEntryIsNotDressedUpAsAMerge() throws {
        let sentence = TripIdeasViewModel.sentence(for: try response(merged: false, unknown: []))
        XCTAssertTrue(sentence.contains("ist im Vorrat"))
        XCTAssertFalse(sentence.contains("schon"))
    }

    func testWhatIsNotKnownIsNamedRatherThanHidden() throws {
        let sentence = TripIdeasViewModel.sentence(
            for: try response(merged: false, unknown: ["Öffnungszeiten", "Kategorie"]),
        )
        XCTAssertTrue(sentence.contains("Unbekannt: Öffnungszeiten, Kategorie."))
    }

    // MARK: - Collections

    func testACollectionSaysWhoseItIs() {
        let own = TripIdeaCollection(ownerId: 1, ownerName: "Anton", own: true)
        let shared = TripIdeaCollection(ownerId: 2, ownerName: "Anna", own: false)
        let anonymous = TripIdeaCollection(ownerId: 3, ownerName: nil, own: false)

        XCTAssertEqual(own.label, "Mein Vorrat")
        XCTAssertEqual(shared.label, "Vorrat von Anna")
        XCTAssertEqual(anonymous.label, "Geteilter Vorrat")
    }
}
