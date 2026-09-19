import XCTest
@testable import FKPhotosLib

/// A spot with an extent (§4.7): decodes beside every plain spot, reads
/// as a route, and leaves the form as a request with its far end.
@MainActor
final class TripSpotExtentTests: XCTestCase {

    private func stop(_ extra: String) throws -> TripStop {
        try JSONDecoder().decode(TripStop.self, from: Data("""
        { "rowId": 3, "osmRef": "manual:route-1", "name": "Panoramaweg Beispiel",
          "lat": 45.88, "lon": 10.84, "category": "route", "dwellMinutes": 180,
          "travelFromPrevious": { "minutes": 5, "distanceM": 300, "travelClass": "short_walk" },
          "status": "planned", "pinned": false, "note": null, "sourceUrl": null,
          "title": null, "localName": null, "wikipediaUrl": null, "photoStop": false\(extra) }
        """.utf8))
    }

    func testAPlainStopHasNoExtent() throws {
        XCTAssertNil(try stop("").extent)
    }

    func testARouteDecodesItsEnd() throws {
        let route = try stop(", \"extent\": { \"end\": { \"lat\": 45.95, \"lon\": 10.84 }, \"lengthM\": 10400, \"ascentM\": 600 }")
        XCTAssertEqual(route.extent?.end, TripCoordinate(lat: 45.95, lon: 10.84))
        XCTAssertEqual(route.extent?.summary, "Strecke · 10 km · 600 Hm")
        XCTAssertEqual(TripCategory.label("route"), "Strecke")
    }

    func testTheSummarySaysOnlyWhatIsKnown() {
        let end = TripCoordinate(lat: 45.95, lon: 10.84)
        XCTAssertEqual(TripSpotExtent(end: end, lengthM: nil, ascentM: nil).summary, "Strecke")
        XCTAssertEqual(TripSpotExtent(end: end, lengthM: 2_500, ascentM: 0).summary, "Strecke · 2,5 km")
        XCTAssertEqual(TripSpotExtent(end: end, lengthM: 800, ascentM: nil).summary, "Strecke · 800 m")
    }

    func testTheFormAsksForBothEndsAndADuration() {
        let model = TripRouteEntryModel(planId: 1, legIndex: 0)
        XCTAssertEqual(model.missing, "ein Name")
        model.name = "Panoramaweg Beispiel"
        XCTAssertEqual(model.missing, "der Startpunkt")
        model.start = TripPlace(name: "Beispielort Nord", subtitle: nil, latitude: 45.88, longitude: 10.84)
        XCTAssertEqual(model.missing, "der Endpunkt")
        model.end = TripPlace(name: "Beispielsee", subtitle: nil, latitude: 45.95, longitude: 10.84)
        XCTAssertNil(model.missing)
        XCTAssertTrue(model.canSave)
    }

    func testTheRequestCarriesTheEndInMetres() throws {
        let model = TripRouteEntryModel(planId: 1, legIndex: 2)
        model.name = " Panoramaweg Beispiel "
        model.start = TripPlace(name: "Beispielort Nord", subtitle: nil, latitude: 45.88, longitude: 10.84)
        model.end = TripPlace(name: "Beispielsee", subtitle: nil, latitude: 45.95, longitude: 10.84)
        model.durationMinutes = 180
        model.lengthText = "10,4"
        model.ascentText = "600"

        let request = try XCTUnwrap(model.request())
        XCTAssertEqual(request.name, "Panoramaweg Beispiel")
        XCTAssertEqual(request.legIndex, 2)
        XCTAssertEqual(request.dwellMinutes, 180)
        XCTAssertEqual(request.end, TripCoordinate(lat: 45.95, lon: 10.84))
        XCTAssertEqual(request.lengthM, 10_400)
        XCTAssertEqual(request.ascentM, 600)
        XCTAssertNil(request.note)
    }

    func testAnUnreadableLengthIsNoLength() {
        XCTAssertNil(TripRouteEntryModel.metres(fromKilometres: ""))
        XCTAssertNil(TripRouteEntryModel.metres(fromKilometres: "zehn"))
        XCTAssertNil(TripRouteEntryModel.metres(fromKilometres: "-3"))
        XCTAssertEqual(TripRouteEntryModel.metres(fromKilometres: "10.5"), 10_500)
    }
}

/// What a route walks past (§4.7), as the block card says it.
@MainActor
final class TripPassedSpotTests: XCTestCase {

    private func spot(_ name: String?) -> TripPassedSpot {
        TripPassedSpot(osmRef: "node:\(name ?? "none")", name: name)
    }

    func testNothingPassedSaysNothing() {
        XCTAssertNil(TripPassedSpot.line([]))
    }

    func testOneAndTwoAreNamed() {
        XCTAssertEqual(TripPassedSpot.line([spot("Belvedere Beispiel")]),
                       "unterwegs: Belvedere Beispiel")
        XCTAssertEqual(TripPassedSpot.line([spot("Belvedere Beispiel"), spot("Tunnel Beispiel")]),
                       "unterwegs: Belvedere Beispiel und Tunnel Beispiel")
    }

    func testMoreThanTwoNamesTheFirstAndCountsTheRest() {
        let passed = [spot("Belvedere Beispiel"), spot("Tunnel Beispiel"), spot("Brücke Beispiel")]
        XCTAssertEqual(TripPassedSpot.line(passed), "unterwegs: Belvedere Beispiel und 2 weitere")
    }

    func testAnUnnamedSpotSaysSoRatherThanBeingBlank() {
        XCTAssertEqual(TripPassedSpot.line([spot(nil)]), "unterwegs: ein Ort ohne Namen")
    }
}

/// A signposted way out of OpenStreetMap (§4.7), as the list shows it.
///
/// Built from named parameters rather than by appending to a JSON
/// string, because appending cannot override a key that is already
/// there: `JSONDecoder` keeps the first of two, so the override is
/// silently ignored and the test asserts against the default.
@MainActor
final class TripNearbyRouteTests: XCTestCase {

    private func route(
        kind: String = "hiking",
        lengthM: Int = 10_400,
        ascentM: Int? = 600,
        roundtrip: Bool = false,
        difficulty: String? = nil,
        network: String? = nil
    ) throws -> TripNearbyRoute {
        func quoted(_ value: String?) -> String {
            guard let value else { return "null" }
            return "\"\(value)\""
        }
        func number(_ value: Int?) -> String {
            guard let value else { return "null" }
            return "\(value)"
        }
        let json = """
        { "osmRef": "relation:1", "name": "Panoramaweg Beispiel",
          "route": "\(kind)", "network": \(quoted(network)), "ref": null,
          "lengthM": \(lengthM), "ascentM": \(number(ascentM)),
          "distanceM": 500, "estimatedMinutes": 210,
          "roundtrip": \(roundtrip), "joined": true, "website": null,
          "difficulty": \(quoted(difficulty)), "inPool": false }
        """
        return try JSONDecoder().decode(TripNearbyRoute.self, from: Data(json.utf8))
    }

    func testTheSummarySaysWhatIsKnown() throws {
        // Ten kilometres and up read as whole ones — the shared helper's
        // rule, and the reason this is not "10,4 km".
        XCTAssertEqual(try route().summary, "10 km · 600 Hm")
        XCTAssertEqual(try route(lengthM: 2_500).summary, "2,5 km · 600 Hm")
    }

    func testItLeavesOutWhatTheMapDoesNotSay() throws {
        // No climb tagged: saying "0 Hm" would claim the way is flat.
        XCTAssertEqual(try route(ascentM: nil).summary, "10 km")
        XCTAssertEqual(try route(ascentM: 0).summary, "10 km")
    }

    func testALoopAndItsGradeAreNamed() throws {
        let loop = try route(roundtrip: true, difficulty: "T2", network: "lwn")
        XCTAssertEqual(loop.summary, "10 km · 600 Hm · Rundweg · T2 · LWN")
    }

    func testWalkingAndRidingLookDifferent() throws {
        XCTAssertEqual(try route().symbolName, "figure.hiking")
        XCTAssertEqual(try route(kind: "foot").symbolName, "figure.hiking")
        XCTAssertEqual(try route(kind: "bicycle").symbolName, "bicycle")
        XCTAssertEqual(try route(kind: "mtb").symbolName, "bicycle")
    }
}
