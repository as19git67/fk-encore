import XCTest
@testable import FKPhotosLib

/// What the spot picker adds to (reise-planen-und-unterwegs.md, Mock 17).
final class TripPickerTargetTests: XCTestCase {
    private func block(_ id: String, budget: Int = 600, used: Int = 0) -> TripBlock {
        let json = """
        {"id":"\(id)","rowId":1,"label":"Tag","kind":"spots","budgetMinutes":\(budget),"usedMinutes":\(used),
         "startMinutes":540,"stops":[]}
        """
        return try! JSONDecoder().decode(TripBlock.self, from: Data(json.utf8))
    }

    private let seestadt = TripExcursion(id: "a", lat: 48.4, lon: 11.0, label: "Seestadt", radiusM: 3_000,
                                         departMinutes: 600, returnMinutes: 780, travelMinutes: 40)

    private func excursionDay() -> TripDay {
        var day = TripDay(id: 3, dayIndex: 2, detailed: true, bufferReason: nil,
                          blocks: [block("day"), block("excursion:a", budget: 140, used: 60), block("day@a")],
                          fixpoints: [])
        day.excursions = [seestadt]
        return day
    }

    private func dayOut() throws -> TripDay {
        var day = TripDay(id: 4, dayIndex: 3, detailed: true, bufferReason: nil, blocks: [block("day")], fixpoints: [])
        day.anchor = try JSONDecoder().decode(TripDayAnchor.self, from: Data("""
        {"lat":48.8,"lon":11.4,"label":"Großstadt","radiusM":4000,"travelMinutes":60}
        """.utf8))
        return day
    }

    private func leg(_ days: [TripDay]) throws -> TripLeg {
        let encoded = String(decoding: try JSONEncoder().encode(days), as: UTF8.self)
        return try JSONDecoder().decode(TripLeg.self, from: Data("""
        { "id": 1, "position": 0, "title": "Bergdorf", "anchor": { "lat": 48.0, "lon": 11.0 },
          "anchorRadiusM": null, "anchorLabel": null, "arriveMinutes": null, "mode": "foot",
          "regionDb": "nom_beispiel", "startDate": null, "days": \(encoded), "pool": [] }
        """.utf8))
    }

    private func place(_ ref: String, lat: Double, lon: Double, dwell: Int? = nil) -> TripPickerItem {
        TripPickerItem(source: .place(TripSearchedPlace(
            osmRef: ref, name: "Beispielort \(ref)", lat: lat, lon: lon, distanceM: nil, categories: [],
            legIndex: 0, openingHours: nil, phone: nil, website: nil, dwellMinutes: dwell,
            inPool: false, planned: false)))
    }

    func testAnExcursionSaysItsWindowAndWhatItStillHolds() {
        let target = TripPickerTargets.excursion(seestadt, on: excursionDay())
        XCTAssertEqual(target.title, "Ausflug nach Seestadt")
        XCTAssertEqual(target.window, "10:40–13:00")
        XCTAssertEqual(target.freeMinutes, 80)
        XCTAssertEqual(target.barLine, "Tag 3 · 10:40–13:00 · noch 1 h 20 frei")
        XCTAssertEqual(target.searchPrompt, "In Seestadt suchen")
        XCTAssertEqual(target.focus, TripDayTripFocus(dayIndex: 2, name: "Seestadt", blockId: "excursion:a"))
        XCTAssertEqual(target.area?.radiusM, 3_000)
    }

    func testOnlyDaysWithAnExcursionOrADayOutAreOffered() throws {
        let plain = TripDay(id: 1, dayIndex: 0, detailed: true, bufferReason: nil, blocks: [block("day")], fixpoints: [])
        let leg = try leg([plain, excursionDay(), try dayOut()])
        let days = TripPickerTargets.days(of: leg)
        XCTAssertEqual(days.map(\.dayIndex), [2, 3])
        XCTAssertEqual(days[1].targets.first?.title, "Ganzer Tag in Großstadt")
        XCTAssertEqual(days[1].targets.first?.line, "ganztägiger Ausflug")
        XCTAssertEqual(TripPickerTargets.stay(leg).line, "der Aufenthalt, um die Unterkunft")
        XCTAssertEqual(TripPickerTargets.stay(leg).searchPrompt, "Name, Kategorie oder Karten-Link")
        let stale = TripPickerTargets.excursion(seestadt, on: excursionDay())
        XCTAssertEqual(TripPickerTargets.refreshed(stale, in: leg)?.freeMinutes, 80)
        XCTAssertNil(TripPickerTargets.refreshed(stale, in: try self.leg([plain])))
    }

    func testAPlaceAtAnExcursionsDestinationSaysSoInTheStaysList() throws {
        let leg = try leg([excursionDay()])
        let away = TripPickerTargets.away(of: leg)
        let near = TripPickerTargets.near(TripCoordinate(lat: 48.41, lon: 11.0), in: away)
        XCTAssertEqual(near.map(TripPickerTargets.nearText), "nahe Seestadt · Ausflug Tag 3")
        XCTAssertNil(TripPickerTargets.near(TripCoordinate(lat: 48.1, lon: 11.0), in: away))
    }

    func testIdeasNearTheDestinationComeFirstNearestFirst() {
        let target = TripPickerTargets.excursion(seestadt, on: excursionDay())
        let far = place("1", lat: 48.0, lon: 11.0)
        let close = place("2", lat: 48.405, lon: 11.0)
        let closer = place("3", lat: 48.401, lon: 11.0)
        let split = TripPickerTargets.splitIdeas([far, close, closer], around: target)
        XCTAssertEqual(split.near.map(\.id), ["3", "2"])
        XCTAssertEqual(split.rest.map(\.id), ["1"])
    }

    func testDistanceAndFitAreToldFromTheDestination() {
        let target = TripPickerTargets.excursion(seestadt, on: excursionDay())
        XCTAssertEqual(TripPickerTargets.fromDestination(TripCoordinate(lat: 48.4, lon: 11.0), target), "am Ziel")
        XCTAssertEqual(TripPickerTargets.fromDestination(TripCoordinate(lat: 48.418, lon: 11.0), target),
                       "2,0 km vom Ziel")
        XCTAssertTrue(TripPickerTargets.doesNotFit(dwellMinutes: 120, target))
        XCTAssertFalse(TripPickerTargets.doesNotFit(dwellMinutes: 60, target))
        XCTAssertFalse(TripPickerTargets.doesNotFit(dwellMinutes: nil, target))
        XCTAssertEqual(TripPickerTargets.misfitText(target), "passt nicht, 1 h 20 frei")
        XCTAssertEqual(TripPickerTargets.freeText(0), "nichts mehr frei")
    }
}
