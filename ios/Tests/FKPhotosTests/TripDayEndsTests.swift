import XCTest
@testable import FKPhotosLib

/// Where a day begins and ends (§4.4).
///
/// The screen's half of a rule the server owns: it may only *say* what
/// the plan already did, so these tests are the same cases as
/// `day-ends.test.ts`.
final class TripDayEndsTests: XCTestCase {

    private func fixpoint(
        _ rowId: Int,
        kind: String = "appointment",
        at: Int,
        duration: Int = 0,
        placed: Bool = true,
    ) throws -> TripFixpoint {
        try JSONDecoder().decode(TripFixpoint.self, from: Data("""
        { "rowId": \(rowId), "kind": "\(kind)", "label": "Fixpunkt \(rowId)",
          "startMinutes": \(at), "durationMinutes": \(duration),
          "travelMinutes": 10, "bufferMinutes": 20,
          "lat": \(placed ? "48.365" : "null"), "lon": \(placed ? "10.886" : "null") }
        """.utf8))
    }

    private func day(_ fixpoints: [TripFixpoint], blockStarts: [Int?] = [9 * 60, 13 * 60]) -> TripDay {
        let blocks = blockStarts.enumerated().map { index, start in
            TripBlock(id: "b\(index)", rowId: index, label: "Block", kind: "spots",
                      budgetMinutes: 180, usedMinutes: 0, startMinutes: start,
                      stops: [], branches: nil)
        }
        return TripDay(id: 1, dayIndex: 0, detailed: true, bufferReason: nil,
                       blocks: blocks, fixpoints: fixpoints)
    }

    func testAnOrdinaryDayNamesNeitherEnd() throws {
        // Both ends are the anchor, which is nearly every day there is.
        let ends = TripDayEnds.of(day([try fixpoint(1, at: 14 * 60, placed: false)]))
        XCTAssertTrue(ends.isOrdinary)
    }

    func testTheDayEndsAtALocatedDeparture() throws {
        let train = try fixpoint(1, kind: "departure", at: 18 * 60 + 40)
        XCTAssertEqual(TripDayEnds.of(day([train])).end?.rowId, 1)
        XCTAssertNil(TripDayEnds.of(day([train])).start)
    }

    func testTheEarlierTrainCatches() throws {
        let early = try fixpoint(1, kind: "departure", at: 16 * 60)
        let late = try fixpoint(2, kind: "departure", at: 21 * 60)
        XCTAssertEqual(TripDayEnds.of(day([late, early])).end?.rowId, 1)
    }

    func testTheDayBeginsWhereTheArrivalLeftThem() throws {
        let arrival = try fixpoint(1, at: 7 * 60, duration: 30)
        XCTAssertEqual(TripDayEnds.of(day([arrival])).start?.rowId, 1)
    }

    func testTheLastThingBeforeTheDayWins() throws {
        let arrival = try fixpoint(1, at: 6 * 60, duration: 20)
        let luggage = try fixpoint(2, at: 7 * 60, duration: 60)
        XCTAssertEqual(TripDayEnds.of(day([arrival, luggage])).start?.rowId, 2)
    }

    func testAnAppointmentInsideTheDayMovesNothing() throws {
        // It would have to split a block to move the route, so it keeps
        // costing its time and nothing else.
        let tour = try fixpoint(1, at: 14 * 60, duration: 90)
        XCTAssertTrue(TripDayEnds.of(day([tour])).isOrdinary)
    }

    func testADayWithoutHoursHasNoStart() throws {
        let arrival = try fixpoint(1, at: 7 * 60, duration: 30)
        XCTAssertNil(TripDayEnds.of(day([arrival], blockStarts: [nil, nil])).start)
    }

    func testHalfACoordinateIsNoPlace() throws {
        let half = try JSONDecoder().decode(TripFixpoint.self, from: Data("""
        { "rowId": 9, "kind": "departure", "label": "Zug", "startMinutes": 1120,
          "durationMinutes": 0, "travelMinutes": 10, "bufferMinutes": 20,
          "lat": 48.365, "lon": null }
        """.utf8))
        XCTAssertFalse(half.hasPlace)
        XCTAssertTrue(TripDayEnds.of(day([half])).isOrdinary)
    }
}
