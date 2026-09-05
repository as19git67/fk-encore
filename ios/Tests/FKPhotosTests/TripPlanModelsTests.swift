import XCTest
@testable import FKPhotosLib

/// Decode guards for the trip-planner JSON contract.
///
/// The planner's shape is the concept's, and the parts that are easy to
/// get wrong are exactly the parts that carry meaning: a day that is not
/// detailed yet is not an empty day (§4.3), a departure is not an
/// appointment (§4.4), an anchor zone is not an address (§4.2). Each of
/// those is a field that would decode fine as the wrong thing, so each
/// gets a test.
final class TripPlanModelsTests: XCTestCase {

    /// Two legs, the second still at trip resolution — invented places
    /// throughout.
    private let planJSON = """
    { "plan": {
        "id": 7, "ownerId": 1, "title": "Zwei Städte",
        "legs": [
          { "id": 11, "position": 0, "title": "Beispielstadt",
            "anchor": { "lat": 48.37, "lon": 10.9 },
            "anchorRadiusM": null, "mode": "foot", "regionDb": "nom_west",
            "startDate": "2026-09-03",
            "days": [
              { "id": 21, "dayIndex": 0, "detailed": true,
                "fixpoints": [
                  { "rowId": 31, "kind": "departure", "label": "Letzter Zug 18:40",
                    "startMinutes": 1120, "durationMinutes": 0, "travelMinutes": 15,
                    "bufferMinutes": 20, "lat": null, "lon": null }
                ],
                "blocks": [
                  { "id": "morning", "rowId": 41, "label": "Vormittag", "kind": "spots",
                    "budgetMinutes": 210, "usedMinutes": 105,
                    "stops": [
                      { "rowId": 51, "osmRef": "node:1", "name": "Stadtmuseum Beispielstadt",
                        "lat": 48.371, "lon": 10.901, "category": "museum",
                        "dwellMinutes": 90, "status": "planned", "pinned": false,
                        "travelFromPrevious": { "minutes": 5, "distanceM": 390, "travelClass": "short_walk" } },
                      { "rowId": 52, "osmRef": "node:2", "name": null,
                        "lat": 48.372, "lon": 10.902, "category": "sight",
                        "dwellMinutes": 30, "status": "skipped", "pinned": true,
                        "travelFromPrevious": { "minutes": 12, "distanceM": 2400, "travelClass": "long_ride" } }
                    ] },
                  { "id": "midday", "rowId": 42, "label": "Mittag", "kind": "meal",
                    "budgetMinutes": 90, "usedMinutes": 0, "stops": [] }
                ] }
            ],
            "pool": [
              { "osmRef": "node:1", "name": "Stadtmuseum Beispielstadt", "lat": 48.371,
                "lon": 10.901, "category": "museum", "dwellMinutes": 90, "score": 4.5,
                "reasons": ["hat einen Wikipedia-Artikel", "passt zu euren Interessen"] }
            ] },
          { "id": 12, "position": 1, "title": "Musterstadt",
            "anchor": { "lat": 48.14, "lon": 11.58 },
            "anchorRadiusM": 1200, "mode": "transit", "regionDb": "nom_east",
            "startDate": null,
            "days": [
              { "id": 22, "dayIndex": 0, "detailed": false, "fixpoints": [],
                "blocks": [
                  { "id": "morning", "rowId": 43, "label": "Vormittag", "kind": "spots",
                    "budgetMinutes": 210, "usedMinutes": 0, "stops": [] }
                ] }
            ],
            "pool": [] }
        ] },
      "droppedBlocks": [
        { "legIndex": 0, "dayIndex": 0, "id": "evening", "label": "Abend",
          "reason": "Letzter Zug 18:40 lässt für „Abend\\" keine Zeit mehr" }
      ] }
    """.data(using: .utf8)!

    private func decodePlan() throws -> TripPlanResponse {
        try JSONDecoder().decode(TripPlanResponse.self, from: planJSON)
    }

    func testDecodesLegsDaysBlocksAndStops() throws {
        let plan = try decodePlan().plan
        XCTAssertEqual(plan.legs.count, 2)
        XCTAssertEqual(plan.legs[0].days[0].blocks.count, 2)
        XCTAssertEqual(plan.legs[0].days[0].blocks[0].stops.count, 2)
        XCTAssertEqual(plan.legs[0].days[0].blocks[0].stops[0].name, "Stadtmuseum Beispielstadt")
    }

    func testUndetailedDayKeepsItsFrame() throws {
        // A day at trip resolution has blocks and budgets but no stops.
        // Reading it as "nothing to do here" is the mistake to avoid.
        let day = try decodePlan().plan.legs[1].days[0]
        XCTAssertFalse(day.detailed)
        XCTAssertEqual(day.blocks.count, 1)
        XCTAssertEqual(day.blocks[0].budgetMinutes, 210)
        XCTAssertTrue(day.blocks[0].stops.isEmpty)
    }

    func testDepartureIsDistinguishedFromAppointment() throws {
        let fix = try decodePlan().plan.legs[0].days[0].fixpoints[0]
        XCTAssertTrue(fix.isDeparture)
        XCTAssertEqual(fix.startsAt, "18:40")
    }

    func testAnchorZoneIsNotAnAddress() throws {
        let legs = try decodePlan().plan.legs
        XCTAssertNil(legs[0].anchorRadiusM)
        XCTAssertEqual(legs[1].anchorRadiusM, 1200)
    }

    func testUnknownTransportModeFallsBackRatherThanFailing() throws {
        // A mode the app has not learned about is still a leg worth
        // showing, so it must not fail the whole decode.
        XCTAssertEqual(TripTransportMode(raw: "transit"), .transit)
        XCTAssertEqual(TripTransportMode(raw: "hovercraft"), .foot)
    }

    func testUnnamedSpotSaysWhatItIsRatherThanShowingNothing() throws {
        // It used to read "Unbenannter Ort", which is true and useless:
        // OpenStreetMap leaves most viewpoints and plenty of
        // attractions unnamed, so a pool of them was a column of
        // identical lines. The name is still missing and still never
        // invented (§10.4) — the row just says which kind of thing it
        // is, which the data does know.
        let stop = try decodePlan().plan.legs[0].days[0].blocks[0].stops[1]
        XCTAssertNil(stop.name)
        XCTAssertEqual(stop.displayName, "Sehenswürdigkeit, ohne Namen")
    }

    func testStopStatusAndPinning() throws {
        let stops = try decodePlan().plan.legs[0].days[0].blocks[0].stops
        XCTAssertEqual(stops[0].stopStatus, .planned)
        XCTAssertEqual(stops[1].stopStatus, .skipped)
        XCTAssertTrue(stops[1].pinned)
        XCTAssertEqual(TripStopStatus(raw: "vielleicht"), .planned)
    }

    func testTravelSymbolFollowsTheMode() throws {
        let stops = try decodePlan().plan.legs[0].days[0].blocks[0].stops
        XCTAssertEqual(stops[0].travelFromPrevious.symbolName, "figure.walk")
        XCTAssertEqual(stops[1].travelFromPrevious.symbolName, "tram")
    }

    func testMealBlockIsMarkedAsHoldingTimeNotAVenue() throws {
        let blocks = try decodePlan().plan.legs[0].days[0].blocks
        XCTAssertFalse(blocks[0].isMeal)
        XCTAssertTrue(blocks[1].isMeal)
    }

    func testUtilisation() throws {
        let block = try decodePlan().plan.legs[0].days[0].blocks[0]
        XCTAssertEqual(block.utilisation, 0.5, accuracy: 0.0001)
        // An empty budget must not divide by zero.
        let meal = try decodePlan().plan.legs[0].days[0].blocks[1]
        XCTAssertEqual(meal.utilisation, 0, accuracy: 0.0001)
    }

    func testDroppedBlocksCarryTheirReason() throws {
        let dropped = try XCTUnwrap(decodePlan().droppedBlocks)
        XCTAssertEqual(dropped.count, 1)
        XCTAssertEqual(dropped[0].id, "evening")
        XCTAssertTrue(dropped[0].reason.contains("Letzter Zug"))
    }
}

/// The planner's unit for a time of day is minutes past midnight, not a
/// `Date`: a fixpoint is "the 18:40 train", and formatting it through a
/// timezone would move it.
final class TripClockTests: XCTestCase {

    func testFormatsTimesOfDay() {
        XCTAssertEqual(TripClock.format(0), "00:00")
        XCTAssertEqual(TripClock.format(9 * 60 + 5), "09:05")
        XCTAssertEqual(TripClock.format(18 * 60 + 40), "18:40")
    }

    func testWrapsRatherThanShowingATwentyFifthHour() {
        XCTAssertEqual(TripClock.format(24 * 60), "00:00")
        XCTAssertEqual(TripClock.format(25 * 60), "01:00")
        XCTAssertEqual(TripClock.format(-60), "23:00")
    }

    func testFormatsDurationsAsABlockCardReadsThem() {
        XCTAssertEqual(TripClock.duration(45), "45 min")
        XCTAssertEqual(TripClock.duration(60), "1 h")
        XCTAssertEqual(TripClock.duration(200), "3 h 20")
    }
}

/// The plan chooser's row (§8.1). Its whole job is to say enough to pick
/// between trips, and the interesting cases are the ones where the
/// traveller named nothing.
final class TripPlanSummaryTests: XCTestCase {

    private func decodeList() throws -> [TripPlanSummary] {
        let json = """
        { "plans": [
            { "id": 1, "title": "Zwei Städte", "legTitles": ["Beispielstadt", "Musterstadt"],
              "dayCount": 6, "startDate": "2026-09-03", "updatedAt": "2026-09-01T10:00:00Z" },
            { "id": 2, "title": null, "legTitles": ["Beispieldorf"],
              "dayCount": 1, "startDate": null, "updatedAt": "2026-08-20T10:00:00Z" },
            { "id": 3, "title": "", "legTitles": [null],
              "dayCount": 3, "startDate": null, "updatedAt": "2026-08-10T10:00:00Z" }
        ] }
        """.data(using: .utf8)!
        return try JSONDecoder().decode(ListTripPlansResponse.self, from: json).plans
    }

    func testUsesTheTitleWhenThereIsOne() throws {
        XCTAssertEqual(try decodeList()[0].displayTitle, "Zwei Städte")
        XCTAssertEqual(try decodeList()[0].routeLabel, "Beispielstadt → Musterstadt")
    }

    func testFallsBackToTheRouteRatherThanShowingNothing() throws {
        let plan = try decodeList()[1]
        XCTAssertEqual(plan.displayTitle, "Beispieldorf")
    }

    func testNamesNothingItWasNotGiven() throws {
        // A trip with no title and no named leg gets a plain label, not
        // an invented one.
        let plan = try decodeList()[2]
        XCTAssertNil(plan.routeLabel)
        XCTAssertEqual(plan.displayTitle, "Reise")
    }

    func testDayCountReadsAsGerman() throws {
        XCTAssertEqual(try decodeList()[0].dayCountLabel, "6 Tage")
        XCTAssertEqual(try decodeList()[1].dayCountLabel, "1 Tag")
    }
}
