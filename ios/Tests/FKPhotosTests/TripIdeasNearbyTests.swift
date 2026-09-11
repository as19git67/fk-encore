import XCTest
@testable import FKPhotosLib

/// What is near here (§20.2).
///
/// The wording again rather than the list: a distance somebody has to
/// convert in their head is not an answer, and "wer hat's gemerkt"
/// is the half of the sentence that makes anybody go.
final class TripIdeasNearbyTests: XCTestCase {

    private func near(_ json: String) throws -> TripNearIdea {
        try JSONDecoder().decode(TripNearIdea.self, from: Data(json.utf8))
    }

    private func near(distanceM: Int, note: String? = nil, addedBy: String? = nil) throws -> TripNearIdea {
        try near("""
        { "id": 1, "osmRef": "way:1", "name": "Biergarten Mühlinsel",
          "lat": 48.1, "lon": 11.5, "distanceM": \(distanceM),
          "category": "food", "dwellMinutes": 60,
          "note": \(note.map { "\"\($0)\"" } ?? "null"),
          "addedBy": \(addedBy.map { "\"\($0)\"" } ?? "null"),
          "validTo": null }
        """)
    }

    func testUnderAKilometreIsMetres() throws {
        XCTAssertEqual(try near(distanceM: 420).distanceText, "420 m")
        XCTAssertEqual(try near(distanceM: 999).distanceText, "999 m")
    }

    func testAboveAKilometreIsOneDecimal() throws {
        // "1437 m" is a number you convert; "1,4 km" is a walk you can
        // picture.
        XCTAssertEqual(try near(distanceM: 1437).distanceText, "1,4 km")
        XCTAssertEqual(try near(distanceM: 1000).distanceText, "1,0 km")
    }

    func testTheNoteAndWhoCollectedItAreBothKept() throws {
        let idea = try near(distanceM: 300, note: "Papa wollte da hin", addedBy: "Papa")
        XCTAssertEqual(idea.subtitle, "Papa wollte da hin — von Papa")
    }

    func testEitherHalfAloneStillMakesALine() throws {
        XCTAssertEqual(try near(distanceM: 300, note: "Schöner Garten").subtitle, "Schöner Garten")
        XCTAssertEqual(try near(distanceM: 300, addedBy: "Anna").subtitle, "von Anna")
    }

    func testAnEntryWithNeitherGetsNoLine() throws {
        XCTAssertNil(try near(distanceM: 300).subtitle)
        XCTAssertNil(try near(distanceM: 300, note: "   ").subtitle)
    }

    func testAPlaceWithoutANameIsNotLeftBlank() throws {
        let nameless = try near("""
        { "id": 2, "osmRef": "manual:3", "name": null,
          "lat": 48.1, "lon": 11.5, "distanceM": 80,
          "category": "sight", "dwellMinutes": 30,
          "note": null, "addedBy": null, "validTo": null }
        """)
        XCTAssertEqual(nameless.displayName, "Unbenannter Ort")
    }

    func testTheHeldBackOnesAreCountedNotListed() throws {
        // The rule's own shape: the number is honest about what stayed
        // quiet, the list would be the nagging it exists to prevent.
        let response = try JSONDecoder().decode(TripIdeaNearbyResponse.self, from: Data("""
        { "ideas": [], "quiet": 3 }
        """.utf8))
        XCTAssertEqual(response.quiet, 3)
        XCTAssertTrue(response.ideas.isEmpty)
    }

    func testTheScreenAsksForFiveKilometres() {
        // "Was ist hier" means here. A radius that quietly covered the
        // county would answer a different question.
        XCTAssertEqual(TripIdeaDefaults.nearbyRadiusM, 5_000)
    }
}
