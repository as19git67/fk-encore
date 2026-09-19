import XCTest
@testable import FKPhotosLib

/// A stop that runs past the end of its block (§4.7).
///
/// The budget is where a block was *meant* to end, not a wall: a
/// four-hour walk planned into a three-and-a-half-hour Vormittag makes
/// lunch late, and the card has to say both halves of that.
@MainActor
final class TripBlockSpillTests: XCTestCase {

    private func block(
        id: String = "morning",
        budget: Int,
        used: Int,
        carried: String = ""
    ) throws -> TripBlock {
        try JSONDecoder().decode(TripBlock.self, from: Data("""
        { "id": "\(id)", "rowId": 1, "label": "Vormittag", "kind": "spots",
          "budgetMinutes": \(budget), "usedMinutes": \(used),
          "startMinutes": 540, "stops": []\(carried) }
        """.utf8))
    }

    func testAPlanFromAnOlderServerCarriesNothing() throws {
        let morning = try block(budget: 210, used: 180)
        XCTAssertNil(morning.carriedInMinutes)
        XCTAssertEqual(morning.startsLateMinutes, 0)
        XCTAssertEqual(morning.overrunMinutes, 0)
    }

    func testABlockThatFitsRunsOverByNothing() throws {
        let morning = try block(budget: 210, used: 210, carried: ", \"carriedInMinutes\": 0")
        XCTAssertEqual(morning.overrunMinutes, 0)
    }

    func testTheFourHourWalkRunsPastTheEndOfItsBlock() throws {
        let morning = try block(budget: 210, used: 240, carried: ", \"carriedInMinutes\": 0")
        XCTAssertEqual(morning.startsLateMinutes, 0)
        XCTAssertEqual(morning.overrunMinutes, 30)
    }

    func testALateStartEatsIntoTheBlockItLandsIn() throws {
        // Lunch begins thirty minutes late and is ninety minutes long,
        // so it absorbs the overrun and hands nothing on.
        let midday = try block(id: "midday", budget: 90, used: 0,
                               carried: ", \"carriedInMinutes\": 30")
        XCTAssertEqual(midday.startsLateMinutes, 30)
        XCTAssertEqual(midday.overrunMinutes, 0)

        // An afternoon that was already full cannot: it passes the late
        // start straight on to the evening.
        let afternoon = try block(id: "afternoon", budget: 210, used: 190,
                                  carried: ", \"carriedInMinutes\": 60")
        XCTAssertEqual(afternoon.overrunMinutes, 40)
    }

    func testANegativeCarryIsReadAsNone() throws {
        // Nothing should ever send one; reading it as a head start
        // would hand the block minutes the day does not have.
        let morning = try block(budget: 210, used: 180,
                                carried: ", \"carriedInMinutes\": -30")
        XCTAssertEqual(morning.startsLateMinutes, 0)
        XCTAssertEqual(morning.overrunMinutes, 0)
    }
}

/// Which candidates the planner will never choose on its own (§4.7).
@MainActor
final class TripPoolLongStopTests: XCTestCase {

    private func leg(blocks: String, dwellMinutes: Int) throws -> (TripLeg, TripCandidate) {
        let leg = try JSONDecoder().decode(TripLeg.self, from: Data("""
        { "id": 1, "position": 0, "title": "Beispielstadt",
          "anchor": { "lat": 45.88, "lon": 10.84 },
          "anchorRadiusM": null, "anchorLabel": null, "arriveMinutes": null,
          "mode": "foot", "regionDb": "nom_beispiel", "startDate": null,
          "days": [ { "id": 1, "dayIndex": 0, "detailed": true,
                      "blocks": [\(blocks)], "fixpoints": [] } ],
          "pool": [] }
        """.utf8))
        let candidate = try JSONDecoder().decode(TripCandidate.self, from: Data("""
        { "osmRef": "manual:route-1", "name": "Panoramaweg Beispiel",
          "lat": 45.88, "lon": 10.84, "category": "route",
          "dwellMinutes": \(dwellMinutes), "score": 1, "reasons": [],
          "origin": "manual", "note": null, "sourceUrl": null,
          "unmatched": false, "title": null, "localName": null,
          "wikipediaUrl": null, "photoStop": false }
        """.utf8))
        return (leg, candidate)
    }

    private let fourBlocks = """
        { "id": "morning", "rowId": 1, "label": "Vormittag", "kind": "spots",
          "budgetMinutes": 210, "usedMinutes": 0, "startMinutes": 540, "stops": [] },
        { "id": "midday", "rowId": 2, "label": "Mittag", "kind": "meal",
          "budgetMinutes": 300, "usedMinutes": 0, "startMinutes": 750, "stops": [] }
        """

    func testAWalkThatFitsAMorningIsNotFlagged() throws {
        let (leg, candidate) = try leg(blocks: fourBlocks, dwellMinutes: 180)
        XCTAssertFalse(TripPoolFilter.needsMoreThanOneBlock(candidate, in: leg))
    }

    func testAFourHourWalkNeedsMoreThanOneBlock() throws {
        // The long lunch must not count: a meal block holds time, not
        // places, so nothing can be planned into it (§10.3).
        let (leg, candidate) = try leg(blocks: fourBlocks, dwellMinutes: 240)
        XCTAssertTrue(TripPoolFilter.needsMoreThanOneBlock(candidate, in: leg))
    }

    func testADayWithNoBlockForSpotsSaysNothing() throws {
        let mealOnly = """
            { "id": "midday", "rowId": 2, "label": "Mittag", "kind": "meal",
              "budgetMinutes": 90, "usedMinutes": 0, "startMinutes": 750, "stops": [] }
            """
        let (leg, candidate) = try leg(blocks: mealOnly, dwellMinutes: 240)
        XCTAssertFalse(TripPoolFilter.needsMoreThanOneBlock(candidate, in: leg))
    }
}
