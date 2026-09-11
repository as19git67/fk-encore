import XCTest
@testable import FKPhotosLib

/// The two remaining ways between collection and trip (§20.3).
///
/// Both are about saying things a shorter implementation would swallow:
/// that an entry is already in the trip, and that what went back into
/// the collection was partly there already.
final class TripPlanIdeasTests: XCTestCase {

    private func idea(
        alreadyInTrip: Bool = false,
        distanceM: Int = 300,
        note: String? = nil,
        addedBy: String? = nil,
    ) throws -> TripIdeaForPlan {
        try JSONDecoder().decode(TripIdeaForPlan.self, from: Data("""
        { "id": 1, "name": "Burgruine Hohenwald", "lat": 48.1, "lon": 11.5,
          "category": "sight",
          "note": \(note.map { "\"\($0)\"" } ?? "null"),
          "addedBy": \(addedBy.map { "\"\($0)\"" } ?? "null"),
          "legIndex": 0, "distanceM": \(distanceM),
          "alreadyInTrip": \(alreadyInTrip) }
        """.utf8))
    }

    func testWhatIsAlreadyInTheTripSaysSoFirst() throws {
        // Somebody scanning for what to add needs to see what they can
        // skip before they read why it is interesting.
        let subtitle = try idea(alreadyInTrip: true, addedBy: "Anna").subtitle
        XCTAssertTrue(subtitle.hasPrefix("schon dabei"))
    }

    func testAnIdeaNotYetInTheTripSaysNothingAboutIt() throws {
        XCTAssertFalse(try idea().subtitle.contains("schon dabei"))
    }

    func testTheNoteBeatsWhoCollectedIt() throws {
        let subtitle = try idea(note: "Papa wollte da hin", addedBy: "Papa").subtitle
        XCTAssertTrue(subtitle.contains("Papa wollte da hin"))
        XCTAssertFalse(subtitle.contains("von Papa"))
    }

    func testDistancesReadAsSomebodyWouldSayThem() throws {
        XCTAssertEqual(try idea(distanceM: 420).distanceText, "420 m")
        XCTAssertEqual(try idea(distanceM: 2400).distanceText, "2,4 km")
    }

    func testAPlaceWithoutANameIsNotLeftBlank() throws {
        let nameless = try JSONDecoder().decode(TripIdeaForPlan.self, from: Data("""
        { "id": 2, "name": null, "lat": 48.1, "lon": 11.5, "category": "sight",
          "note": null, "addedBy": null, "legIndex": 1, "distanceM": 50,
          "alreadyInTrip": false }
        """.utf8))
        XCTAssertEqual(nameless.displayName, "Unbenannter Ort")
    }

    // MARK: - What went back into the collection

    private func kept(_ kept: Int, alreadyThere: Int) -> TripKeptForNextTimeResponse {
        TripKeptForNextTimeResponse(kept: kept, alreadyThere: alreadyThere)
    }

    func testOneSpotKeptIsSingular() {
        XCTAssertEqual(kept(1, alreadyThere: 0).sentence, "Im Vorrat gemerkt.")
    }

    func testSeveralKeptAreCounted() {
        XCTAssertEqual(kept(3, alreadyThere: 0).sentence, "3 Spots im Vorrat gemerkt.")
    }

    func testAlreadyCollectedIsNotAnError() {
        // The endpoint counts it rather than refusing: the trip found it
        // worth keeping and so did somebody earlier (§20.3).
        XCTAssertEqual(kept(0, alreadyThere: 1).sentence, "War schon im Vorrat.")
        XCTAssertEqual(kept(0, alreadyThere: 2).sentence, "Waren schon im Vorrat.")
    }

    func testABatchSaysBothHalves() {
        XCTAssertEqual(kept(2, alreadyThere: 1).sentence, "2 gemerkt, 1 waren schon da.")
    }
}
