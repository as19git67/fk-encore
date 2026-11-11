import XCTest
@testable import FKPhotosLib

/// Open spots (reise-planen-und-unterwegs.md, stage 8, step 3).
final class TripOpenSpotsTests: XCTestCase {
    private func capacity(must: Int, want: Int, maybe: Int, free: Int, fits: Bool, over: Int = 0) -> TripStayCapacity {
        TripStayCapacity(mustMinutes: must, wantMinutes: want, maybeMinutes: maybe,
                         freeMinutes: free, days: 3, fits: fits, overMinutes: over)
    }

    func testTheCapacityLineSaysWhatFitsInRoughHours() {
        let fitting = capacity(must: 420, want: 300, maybe: 180, free: 960, fits: true)
        XCTAssertEqual(TripOpenSpots.capacityLine(fitting), "ca. Muss 7 h · Will 5 h · frei 16 h")
        XCTAssertEqual(TripOpenSpots.capacityDetail(fitting),
                       "passt · Wenn Zeit 3 h kommen dazu, falls Zeit bleibt")
    }

    func testTheCapacityLineSaysHowMuchIsTooMuch() {
        let tight = capacity(must: 420, want: 0, maybe: 0, free: 300, fits: false, over: 120)
        XCTAssertEqual(TripOpenSpots.capacityLine(tight), "ca. Muss 7 h, frei 5 h – 2 h zu viel")
    }

    func testHoursRoundToHalfHours() {
        XCTAssertEqual(TripOpenSpots.hours(45), "45 min")
        XCTAssertEqual(TripOpenSpots.hours(100), "1,5 h")
        XCTAssertEqual(TripOpenSpots.hours(125), "2 h")
    }

    func testAnOpenSpotTravelsByItsOwnDragId() {
        let id = TripOpenSpots.dragId("node:7")
        XCTAssertEqual(TripOpenSpots.osmRef(fromDragId: id), "node:7")
        XCTAssertNil(TripStayPlan.rowId(fromDragId: id))
        XCTAssertNil(TripOpenSpots.osmRef(fromDragId: "trip-stop:3"))
    }

    func testAFillProposalDecodes() throws {
        let json = """
        {"proposal":{"dayIndex":1,"label":"Fr 13.6.","freeMinutes":420,"overrunMinutes":0,
         "picks":[{"osmRef":"node:1","name":"Beispielkirche","reasons":["Muss","heute geöffnet"]}],
         "line":[{"osmRef":"node:1","name":"Beispielkirche","etaMinutes":540,"proposed":true},
                 {"osmRef":"node:2","name":"Burgführung","etaMinutes":930,"proposed":false}]},
         "degraded":false}
        """
        let response = try JSONDecoder().decode(TripFillDayResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.proposal.picks.first?.reasons, ["Muss", "heute geöffnet"])
        XCTAssertEqual(response.proposal.line.filter(\.proposed).count, 1)
    }
}
