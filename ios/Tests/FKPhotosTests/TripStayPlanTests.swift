import XCTest
@testable import FKPhotosLib

/// A stay planned as a whole (reise-planen-und-unterwegs.md, stage 3).
final class TripStayPlanTests: XCTestCase {
    private func stop(_ id: Int, eta: Int? = nil, dwell: Int = 60) -> String {
        """
        {"rowId":\(id),"osmRef":"node:\(id)","name":"Beispielort \(id)","lat":48.37,"lon":10.9,
         "category":"museum","dwellMinutes":\(dwell),
         "travelFromPrevious":{"minutes":10,"distanceM":800,"travelClass":"short_walk"},
         "status":"planned","pinned":false,"note":null,"sourceUrl":null,"title":null,
         "localName":null,"wikipediaUrl":null,"photoStop":false\(eta.map { ",\"etaMinutes\":\($0)" } ?? "")}
        """
    }

    private func block(_ id: String, kind: String = "spots", _ stops: [String]) -> TripBlock {
        let json = """
        {"id":"\(id)","rowId":1,"label":"Tag","kind":"\(kind)","budgetMinutes":600,"usedMinutes":0,
         "startMinutes":540,"stops":[\(stops.joined(separator: ","))]}
        """
        return try! JSONDecoder().decode(TripBlock.self, from: Data(json.utf8))
    }

    private func day(_ index: Int, _ blocks: [TripBlock], planned: Int? = nil, over: Int? = nil) -> TripDay {
        var day = TripDay(id: index + 1, dayIndex: index, detailed: true, bufferReason: nil,
                          blocks: blocks, fixpoints: [])
        if let planned {
            day.window = TripDayWindow(startMinutes: 540, endMinutes: 1080)
            day.plannedMinutes = planned
            day.overrunMinutes = over
        }
        return day
    }

    func testADropLandsBeforeTheCardItFallsOnAcrossBlocks() throws {
        let d = day(0, [block("a", [stop(1), stop(2)]), block("meal", kind: "meal", []), block("b", [stop(3)])])
        XCTAssertEqual(TripStayPlan.stops(of: d).map(\.rowId), [1, 2, 3])
        let first = try XCTUnwrap(TripStayPlan.dropTarget(day: d, before: 1))
        XCTAssertEqual(first.blockId, "a")
        XCTAssertEqual(first.position, 1)
        let third = try XCTUnwrap(TripStayPlan.dropTarget(day: d, before: 2))
        XCTAssertEqual(third.blockId, "b")
        XCTAssertEqual(third.position, 0)
        let end = try XCTUnwrap(TripStayPlan.dropTarget(day: d, before: nil))
        XCTAssertEqual(end.blockId, "b")
        XCTAssertNil(end.position)
    }

    func testAnEmptyDayTakesADropAtItsEnd() throws {
        let target = try XCTUnwrap(TripStayPlan.dropTarget(day: day(1, [block("day", [])]), before: nil))
        XCTAssertEqual(target.blockId, "day")
        XCTAssertNil(TripStayPlan.dropTarget(day: day(1, []), before: nil))
    }

    func testTheDragIdCarriesTheStop() {
        let d = day(0, [block("day", [stop(42)])])
        let id = TripStayPlan.dragId(TripStayPlan.stops(of: d)[0])
        XCTAssertEqual(TripStayPlan.rowId(fromDragId: id), 42)
        XCTAssertNil(TripStayPlan.rowId(fromDragId: "node:42"))
    }

    func testTheHeaderSaysPlannedOfAvailable() {
        XCTAssertEqual(TripStayPlan.fillLine(day(0, [], planned: 200)), "3 h 20 von 9 h")
        XCTAssertEqual(TripStayPlan.fillLine(day(0, [], planned: 0)), "noch frei")
        XCTAssertEqual(TripStayPlan.fillLine(day(0, [], planned: 600, over: 60)), "1 h zu viel")
        XCTAssertNil(TripStayPlan.fillLine(day(0, [])))
        XCTAssertEqual(TripStayPlan.fill(day(0, [], planned: 270)) ?? 0, 0.5, accuracy: 1e-9)
    }

    func testTheCardSaysWhenAndHowLong() {
        let d = day(0, [block("day", [stop(1, eta: 630, dwell: 90), stop(2, dwell: 45)])])
        let stops = TripStayPlan.stops(of: d)
        XCTAssertEqual(TripStayPlan.caption(stops[0]), "ca. 10:30")
        XCTAssertEqual(TripStayPlan.caption(stops[1]), "")
        // The kind and the length stand on the line above the time.
        XCTAssertEqual(TripStayPlan.kindLine(stops[0]), "\(TripCategory.label("museum")) · 1 h 30")
        XCTAssertNil(TripStayPlan.visitedLine(day(1, [])))
        XCTAssertEqual(TripStayPlan.visitedLine(d), "0 von 2 besucht")
    }

    func testTheSliderFindsWhereThePlanHasYou() throws {
        let leg = try JSONDecoder().decode(TripLeg.self, from: Data("""
        { "id": 1, "position": 0, "title": "Beispielstadt", "anchor": { "lat": 48.0, "lon": 11.0 },
          "anchorRadiusM": null, "anchorLabel": null, "arriveMinutes": null, "mode": "foot",
          "regionDb": "nom_beispiel", "startDate": null, "days": [], "pool": [] }
        """.utf8))
        // One stop at 48.37 / 10.9 from 10:30 for 90 minutes; the day starts at 09:00.
        let d = day(0, [block("day", [stop(1, eta: 630, dwell: 90)])], planned: 90)
        let start = try XCTUnwrap(TripStayPlan.position(at: 540, day: d, leg: leg))
        XCTAssertEqual(start.lat, 48.0, accuracy: 1e-9)
        let halfway = try XCTUnwrap(TripStayPlan.position(at: 585, day: d, leg: leg))
        XCTAssertEqual(halfway.lat, 48.185, accuracy: 1e-9)
        let there = try XCTUnwrap(TripStayPlan.position(at: 700, day: d, leg: leg))
        XCTAssertEqual(there.lat, 48.37, accuracy: 1e-9)
        XCTAssertNil(TripStayPlan.position(at: 600, day: day(0, [block("day", [stop(2)])]), leg: leg))
    }

    func testADayTripSaysTheWayThereAndBack() throws {
        func anchor(_ times: String) throws -> TripDayAnchor {
            try JSONDecoder().decode(TripDayAnchor.self, from: Data("""
            {"lat":48.2,"lon":11.1,"label":"Beispielheim","radiusM":null,"travelMinutes":45\(times)}
            """.utf8))
        }
        XCTAssertEqual(TripStayPlan.dayTripLine(try anchor(",\"departMinutes\":540,\"returnMinutes\":1050")),
                       "hin 09:00 bis 09:45 · zurück ab 17:30")
        XCTAssertEqual(TripStayPlan.dayTripLine(try anchor("")), "je 45 min hin und zurück")
    }

    func testAPinReasonReadsBackAndAnUnknownOneIsNone() throws {
        let json = """
        {"rowId":7,"kind":"appointment","label":"Beispieltrattoria","startMinutes":1200,"durationMinutes":90,
         "travelMinutes":0,"bufferMinutes":20,"lat":null,"lon":null,"blockId":null,"spotRef":"node:1",
         "pinReason":"reservation"}
        """
        let fix = try JSONDecoder().decode(TripFixpoint.self, from: Data(json.utf8))
        XCTAssertEqual(fix.reason, .reservation)
        XCTAssertTrue(fix.isVisit)
        XCTAssertNil(TripPinReason(raw: "guess"))
        XCTAssertNil(TripPinReason(raw: nil))
    }
}
