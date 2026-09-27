import XCTest
@testable import FKPhotosLib

/// The moment a stop was ticked off, as the server writes it (§8.5).
final class TripInstantTests: XCTestCase {

    func testReadsTheServersMillisecondsAndThePlainForm() {
        let precise = TripInstant.parse("2026-09-05T08:30:00.000Z")
        let plain = TripInstant.parse("2026-09-05T08:30:00Z")
        XCTAssertNotNil(precise)
        XCTAssertEqual(precise, plain)
        XCTAssertNil(TripInstant.parse("gestern"))
    }

    func testTheOffsetIsThatOfThePlaceAndTheDay() {
        let berlin = TimeZone(identifier: "Europe/Berlin")!
        let summer = TripInstant.parse("2026-07-01T12:00:00Z")!
        let winter = TripInstant.parse("2026-01-15T12:00:00Z")!
        XCTAssertEqual(TripInstant.utcOffsetMinutes(at: summer, timeZone: berlin), 120)
        XCTAssertEqual(TripInstant.utcOffsetMinutes(at: winter, timeZone: berlin), 60)
    }

    func testAReportQueuedByAnOlderBuildStillDecodes() throws {
        // Written before the offset was sent: it is ticked, not moved.
        let json = """
        {"planId":1,"stopId":2,"osmRef":"node:2","name":"Ort 2",
         "arrivedAt":"2026-09-01T10:00:00Z","leftAt":"2026-09-01T10:40:00Z",
         "dwellMinutes":40,"hasMatchingPhoto":false}
        """
        let report = try JSONDecoder().decode(TripVisitReport.self, from: Data(json.utf8))
        XCTAssertNil(report.utcOffsetMinutes)
        XCTAssertEqual(report.stopId, 2)
    }

    private func stop(status: String, doneAt: String?) -> TripStop {
        var stop = TripStop(
            rowId: 1, osmRef: "node:1", name: "Ort 1", lat: 45.88, lon: 10.84,
            category: "sight", dwellMinutes: 30,
            travelFromPrevious: TripTravel(minutes: 0, distanceM: 0, travelClass: "short_walk"),
            status: status, pinned: false, note: nil, sourceUrl: nil, title: nil, localName: nil,
            wikipediaUrl: nil, photoStop: nil,
        )
        stop.doneAt = doneAt
        return stop
    }

    func testTheRowShowsTheTimeOnlyForADoneStopThatKnowsIt() throws {
        let at = "2026-09-05T08:30:00.000Z"
        let expected = TripClock.format(TripDayTimeline.minutesOfDay(try XCTUnwrap(TripInstant.parse(at))))
        XCTAssertEqual(stop(status: "done", doneAt: at).doneTime, expected)
        // Ticked before the time was kept: done, time unknown.
        XCTAssertNil(stop(status: "done", doneAt: nil).doneTime)
        // Reopened: whatever was stamped no longer counts.
        XCTAssertNil(stop(status: "planned", doneAt: at).doneTime)
    }
}
