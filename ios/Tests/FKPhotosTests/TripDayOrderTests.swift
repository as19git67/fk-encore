import XCTest
@testable import FKPhotos

/// The day of ideas as one window (ideas plan, stage 4).
final class TripDayOrderTests: XCTestCase {
    private func stop(_ id: Int, eta: Int? = nil) -> TripStop {
        let json = """
        {"rowId":\(id),"osmRef":"node:\(id)","name":"Beispielort \(id)","lat":48.37,"lon":10.9,
         "category":"museum","dwellMinutes":45,
         "travelFromPrevious":{"minutes":10,"distanceM":800,"travelClass":"short_walk"},
         "status":"planned","pinned":true,"note":null,"sourceUrl":null,"title":null,
         "localName":null,"wikipediaUrl":null,"photoStop":false\(eta.map { ",\"etaMinutes\":\($0)" } ?? "")}
        """
        return try! JSONDecoder().decode(TripStop.self, from: Data(json.utf8))
    }

    func testABreakStandsWhereItWasPut() {
        let pause = TripDayBreak(id: "b", label: "Mittag", minutes: 60, blockId: "day", position: 1)
        let line = TripDayClock.line(stops: [stop(1), stop(2), stop(3)], breaks: [pause])
        XCTAssertEqual(line.map(\.id), ["stop-1", "break-b", "stop-2", "stop-3"])
    }

    func testABreakPastTheEndComesLast() {
        let pause = TripDayBreak(id: "b", label: "Kaffee", minutes: 30, blockId: "day", position: 9)
        let line = TripDayClock.line(stops: [stop(1)], breaks: [pause])
        XCTAssertEqual(line.map(\.id), ["stop-1", "break-b"])
    }

    func testTheEstimateReadsAsAnApproximateTime() {
        XCTAssertEqual(TripDayClock.eta(stop(1, eta: 640)), "ca. 10:40")
        XCTAssertNil(TripDayClock.eta(stop(1)))
    }

    func testTheDaySaysWhatItHoldsAndWhatIsTooMuch() {
        var day = TripDay(id: 1, dayIndex: 0, detailed: true, bufferReason: nil, blocks: [], fixpoints: [])
        XCTAssertNil(TripDayClock.summary(for: day))
        day.window = TripDayWindow(startMinutes: 540, endMinutes: 1140)
        day.plannedMinutes = 270
        day.freeMinutes = 330
        day.overrunMinutes = 0
        XCTAssertEqual(TripDayClock.summary(for: day), "4 h 30 von 10 h verplant · 5 h 30 frei")
        day.overrunMinutes = 70
        XCTAssertEqual(TripDayClock.summary(for: day), "4 h 30 von 10 h verplant · 1 h 10 zu viel")
    }

    func testAdviceIsForItsOwnDay() {
        let advice = TripOrderAdvice(legIndex: 0, dayIndex: 2, overrunMinutes: 30, toDrop: ["node:4"])
        XCTAssertTrue(advice.applies(legIndex: 0, dayIndex: 2))
        XCTAssertFalse(advice.applies(legIndex: 0, dayIndex: 1))
        XCTAssertTrue(advice.suggestsDropping("node:4"))
    }
}
