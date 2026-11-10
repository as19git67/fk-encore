import XCTest
@testable import FKPhotosLib

/// On the road (reise-planen-und-unterwegs.md, stage 5).
final class TripOnTheRoadTests: XCTestCase {
    private func stop(_ id: Int, status: String = "planned", doneAt: String? = nil, dwell: Int = 60) -> String {
        """
        {"rowId":\(id),"osmRef":"node:\(id)","name":"Beispielort \(id)","lat":48.37,"lon":\(10.9 + Double(id) * 0.001),
         "category":"museum","dwellMinutes":\(dwell),
         "travelFromPrevious":{"minutes":10,"distanceM":800,"travelClass":"short_walk"},
         "status":"\(status)","pinned":false,"note":null,"sourceUrl":null,"title":null,
         "localName":null,"wikipediaUrl":null,"photoStop":false\(doneAt.map { ",\"doneAt\":\"\($0)\"" } ?? "")}
        """
    }

    private func day(_ index: Int, _ stops: [String], window: Bool = true) -> TripDay {
        let json = """
        {"id":"day","rowId":1,"label":"Tag","kind":"spots","budgetMinutes":600,"usedMinutes":0,
         "startMinutes":540,"stops":[\(stops.joined(separator: ","))]}
        """
        let block = try! JSONDecoder().decode(TripBlock.self, from: Data(json.utf8))
        var day = TripDay(id: index + 1, dayIndex: index, detailed: true, bufferReason: nil,
                          blocks: [block], fixpoints: [])
        if window { day.window = TripDayWindow(startMinutes: 540, endMinutes: 1140) }
        return day
    }

    private func leg(start: String?, _ days: [TripDay]) -> TripLeg {
        TripLeg(id: 1, position: 0, title: "Musterstadt",
                anchor: TripCoordinate(lat: 48.37, lon: 10.9), anchorRadiusM: nil, anchorLabel: nil,
                arriveMinutes: nil, mode: "foot", regionDb: "nom_test", awaitingRegion: false,
                startDate: start, days: days, pool: [])
    }

    func testTheDaysAreOverBeingLivedOrToCome() {
        let l = leg(start: "2030-09-05", [day(0, []), day(1, []), day(2, [])])
        XCTAssertEqual(TripOnTheRoad.phase(of: 0, in: l, today: "2030-09-06"), .past)
        XCTAssertEqual(TripOnTheRoad.phase(of: 1, in: l, today: "2030-09-06"), .running)
        XCTAssertEqual(TripOnTheRoad.phase(of: 2, in: l, today: "2030-09-06"), .future)
        XCTAssertEqual(TripOnTheRoad.phase(of: 0, in: leg(start: nil, []), today: "2030-09-06"), .undated)
        XCTAssertTrue(TripOnTheRoad.isUnderway(l, today: "2030-09-07"))
        XCTAssertFalse(TripOnTheRoad.isUnderway(l, today: "2030-09-08"))
    }

    func testVisitedComesFirstInTheOrderItHappened() {
        let d = day(0, [
            stop(1, status: "done", doneAt: "2030-09-05T12:00:00Z"),
            stop(2),
            stop(3, status: "done", doneAt: "2030-09-05T10:00:00Z"),
            stop(4, status: "skipped"),
            stop(5),
        ])
        let order = TripOnTheRoad.runningOrder(TripStayPlan.stops(of: d))
        XCTAssertEqual(order.settled.map(\.rowId), [3, 1, 4])
        XCTAssertEqual(order.open.map(\.rowId), [2, 5])
        XCTAssertEqual(TripOnTheRoad.next(TripStayPlan.stops(of: d))?.rowId, 2)
        let byId = Dictionary(uniqueKeysWithValues: TripStayPlan.stops(of: d).map { ($0.rowId, $0.lon) })
        XCTAssertEqual(TripOnTheRoad.visitPath(d, diary: nil).map(\.lon), [byId[3]!, byId[1]!])
    }

    func testAFreshCheckOffersDochNichtForAQuarterOfAnHour() throws {
        let stops = TripStayPlan.stops(of: day(0, [stop(1, status: "done", doneAt: "2030-09-05T10:00:00Z")]))
        let at = try XCTUnwrap(TripInstant.parse("2030-09-05T10:00:00Z"))
        XCTAssertTrue(TripOnTheRoad.isFresh(stops[0], now: at.addingTimeInterval(10 * 60)))
        XCTAssertFalse(TripOnTheRoad.isFresh(stops[0], now: at.addingTimeInterval(20 * 60)))
    }

    func testBehindPlanCountsWhatIsLeftFromNow() {
        // Two open stops of 60 min plus 10 min on the way each: 140 min.
        let d = day(0, [stop(1, status: "done", doneAt: "2030-09-05T10:00:00Z"), stop(2), stop(3)])
        XCTAssertNil(TripOnTheRoad.behindMinutes(d, nowMinutes: 16 * 60))
        XCTAssertEqual(TripOnTheRoad.behindMinutes(d, nowMinutes: 18 * 60), 80)
        XCTAssertNil(TripOnTheRoad.behindMinutes(day(0, [stop(2)], window: false), nowMinutes: 23 * 60))
    }

    func testWhatWasMissedIsAskedInTheEveningOrAfterwards() {
        let d = day(0, [stop(1, status: "done", doneAt: "2030-09-05T10:00:00Z"), stop(2)])
        XCTAssertTrue(TripOnTheRoad.missed(d, phase: .running, nowMinutes: 15 * 60).isEmpty)
        XCTAssertEqual(TripOnTheRoad.missed(d, phase: .running, nowMinutes: 20 * 60).map(\.rowId), [2])
        XCTAssertEqual(TripOnTheRoad.missed(d, phase: .past, nowMinutes: 0).map(\.rowId), [2])
        XCTAssertTrue(TripOnTheRoad.missed(d, phase: .future, nowMinutes: 23 * 60).isEmpty)

        let l = leg(start: "2030-09-05", [d, day(1, []), day(2, [])])
        XCTAssertEqual(TripOnTheRoad.laterDay(after: 0, in: l, today: "2030-09-05")?.dayIndex, 1)
        XCTAssertNil(TripOnTheRoad.laterDay(after: 2, in: l, today: "2030-09-05"))
    }

    func testTheForecastReachesAWeek() {
        let l = leg(start: "2030-09-05", (0..<10).map { day($0, []) })
        XCTAssertTrue(TripOnTheRoad.hasForecast(0, in: l, today: "2030-09-05"))
        XCTAssertTrue(TripOnTheRoad.hasForecast(7, in: l, today: "2030-09-05"))
        XCTAssertFalse(TripOnTheRoad.hasForecast(8, in: l, today: "2030-09-05"))
        XCTAssertFalse(TripOnTheRoad.hasForecast(0, in: l, today: "2030-09-06"))
        XCTAssertFalse(TripOnTheRoad.hasForecast(0, in: leg(start: nil, [day(0, [])]), today: "2030-09-05"))
    }

    func testAPastDayIsOneLine() throws {
        let d = day(0, [stop(1, status: "done", doneAt: "2030-09-05T10:00:00Z"), stop(2)])
        let json = """
        {"date":"2030-09-05","spots":[{"osmRef":"node:1","arrivedAt":"2030-09-05T10:00:00Z",
          "weather":{"temperatureC":18.4,"precipitationMm":0,"cloudCover":10},"photoCount":4,
          "photos":[{"id":7,"filename":"a.jpg"}]}],
         "unplanned":[{"visitId":3,"name":"Beispielhof","osmRef":null,"lat":48.4,"lon":10.9,
          "arrivedAt":"2030-09-05T13:00:00Z","leftAt":null,"weather":null,"photoCount":1,"photos":[]}]}
        """
        let diary = try JSONDecoder().decode(TripDayDiary.self, from: Data(json.utf8))
        XCTAssertEqual(TripOnTheRoad.pastLine(d, diary: diary), "2 besucht · 1 nicht geschafft · 5 Fotos")
        XCTAssertEqual(diary.spot("node:1")?.weather?.degrees, "18°")
        XCTAssertEqual(diary.spot("node:1")?.weather?.symbolName, "sun.max")
        XCTAssertEqual(TripOnTheRoad.visitPath(d, diary: diary).count, 2)
    }
}
