import XCTest
@testable import FKPhotosLib

/// The day of ideas as one band (ideas plan, stage 5).
final class TripDayBandTests: XCTestCase {
    private func stop(_ id: Int, eta: Int, travel: Int, dwell: Int, wait: Int = 0) -> String {
        """
        {"rowId":\(id),"osmRef":"node:\(id)","name":"Beispielort \(id)","lat":48.37,"lon":10.9,
         "category":"museum","dwellMinutes":\(dwell),
         "travelFromPrevious":{"minutes":\(travel),"distanceM":800,"travelClass":"short_walk"},
         "status":"planned","pinned":true,"note":null,"sourceUrl":null,"title":null,
         "localName":null,"wikipediaUrl":null,"photoStop":false,"etaMinutes":\(eta),"waitMinutes":\(wait)}
        """
    }

    private func block(_ stops: [String]) -> TripBlock {
        let json = """
        {"id":"day","rowId":1,"label":"Tag","kind":"spots","budgetMinutes":600,"usedMinutes":0,
         "startMinutes":540,"stops":[\(stops.joined(separator: ","))]}
        """
        return try! JSONDecoder().decode(TripBlock.self, from: Data(json.utf8))
    }

    /// 09:00–19:00: a 10-minute way and an hour, a break, a way, a wait and 45 minutes.
    private func day() -> TripDay {
        var day = TripDay(id: 1, dayIndex: 0, detailed: true, bufferReason: nil,
                          blocks: [block([
                              stop(1, eta: 550, travel: 10, dwell: 60),
                              stop(2, eta: 720, travel: 20, dwell: 45, wait: 10),
                          ])],
                          fixpoints: [])
        day.breaks = [TripDayBreak(id: "b", label: "Mittag", minutes: 60, blockId: "day", position: 1, etaMinutes: 610)]
        day.window = TripDayWindow(startMinutes: 540, endMinutes: 1140)
        day.plannedMinutes = 195
        return day
    }

    func testTheSegmentsLieWhereTheTimesAre() throws {
        let band = try XCTUnwrap(TripDayBandModel(day: day()))
        XCTAssertEqual(band.segments.map(\.id), ["way-1", "stop-1", "break-b", "way-2", "stop-2"])
        let way2 = band.segments.first { $0.id == "way-2" }!
        // Arrived at 11:50 after twenty minutes, waited ten, in at 12:00.
        XCTAssertEqual(way2.startMinutes, 690)
        XCTAssertEqual(way2.endMinutes, 710)
        XCTAssertEqual(band.travelMinutes, 30)
    }

    func testTheWidthsAddUpToWhatIsPlannedAndWaited() throws {
        let band = try XCTUnwrap(TripDayBandModel(day: day()))
        let covered = band.segments.reduce(0.0) { $0 + band.fraction($1.endMinutes) - band.fraction($1.startMinutes) }
        // 10 + 60 + 60 + 20 + 45 of 600; the wait is the gap between way and visit.
        XCTAssertEqual(covered, 195.0 / 600.0, accuracy: 1e-9)
        XCTAssertEqual(band.fraction(400), 0)
        XCTAssertEqual(band.fraction(1300), 1)
    }

    func testTheSentenceSaysPlannedAndUnderway() throws {
        let band = try XCTUnwrap(TripDayBandModel(day: day()))
        XCTAssertEqual(band.sentence, "3 h 15 von 10 h verplant, 30 min unterwegs")
        XCTAssertEqual(band.fill, 195.0 / 600.0, accuracy: 1e-9)
    }

    func testADayWithoutAWindowHasNoBand() {
        let plain = TripDay(id: 1, dayIndex: 0, detailed: true, bufferReason: nil, blocks: [], fixpoints: [])
        XCTAssertNil(TripDayBandModel(day: plain))
    }
}
