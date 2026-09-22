import XCTest
@testable import FKPhotosLib

/// A route's course and the file it turns into (§4.7).
///
/// Two things carry the risk on this side and both are here. One: an
/// answer from a backend that does not know about courses yet must
/// still decode — the whole screen fails otherwise, not just the line
/// on the map. Two: the file name, which the app builds a second time
/// because `downloadData` hands back bytes and no headers, has to
/// agree with the one the server writes.
final class TripRouteCourseTests: XCTestCase {

    private func route(_ json: String) throws -> TripNearbyRoute {
        try JSONDecoder().decode(TripNearbyRoute.self, from: Data(json.utf8))
    }

    /// A route as the current backend sends it.
    private let withCourse = """
    { "osmRef": "relation:7", "name": "Panoramaweg Beispiel", "route": "hiking",
      "network": "lwn", "ref": "B7", "lengthM": 10000, "ascentM": 600,
      "distanceM": 500, "estimatedMinutes": 210, "roundtrip": false,
      "joined": true, "website": null, "difficulty": "T2", "inPool": false,
      "via": [{ "lat": 45.88, "lon": 10.84 },
              { "lat": 45.90, "lon": 10.85 },
              { "lat": 45.92, "lon": 10.84 }] }
    """

    /// The same route from a backend older than this app.
    private let withoutCourse = """
    { "osmRef": "relation:7", "name": "Panoramaweg Beispiel", "route": "hiking",
      "network": "lwn", "ref": "B7", "lengthM": 10000, "ascentM": 600,
      "distanceM": 500, "estimatedMinutes": 210, "roundtrip": false,
      "joined": true, "website": null, "difficulty": "T2", "inPool": false }
    """

    func testTheCourseArrivesAsPoints() throws {
        let decoded = try route(withCourse)
        XCTAssertEqual(decoded.via?.count, 3)
        XCTAssertTrue(decoded.hasCourse)
        XCTAssertEqual(decoded.via?.first?.lat, 45.88)
    }

    func testAnOlderBackendStillDecodes() throws {
        // Not a cosmetic loss: a non-optional `via` would fail the
        // whole row, and with it the whole screen.
        let decoded = try route(withoutCourse)
        XCTAssertNil(decoded.via)
        XCTAssertFalse(decoded.hasCourse)
        XCTAssertEqual(decoded.name, "Panoramaweg Beispiel")
    }

    func testOnePointIsNotACourse() throws {
        let decoded = try route("""
        { "osmRef": "relation:7", "name": "Weg", "route": "hiking", "network": null,
          "ref": null, "lengthM": 1000, "ascentM": null, "distanceM": 10,
          "estimatedMinutes": 20, "roundtrip": false, "joined": false,
          "website": null, "difficulty": null, "inPool": false,
          "via": [{ "lat": 45.88, "lon": 10.84 }] }
        """)
        XCTAssertFalse(decoded.hasCourse)
    }

    func testAWayWithNoCourseStillKnowsWhereItStarts() throws {
        // A relation whose members do not join up has no course at
        // all. Its start is then the one thing known about it, and the
        // screen shows that rather than an empty map.
        let decoded = try route("""
        { "osmRef": "relation:7", "name": "Lückenweg", "route": "foot", "network": null,
          "ref": null, "lengthM": 4000, "ascentM": null, "distanceM": 10,
          "estimatedMinutes": 60, "roundtrip": false, "joined": false,
          "website": null, "difficulty": null, "inPool": false,
          "start": { "lat": 45.88, "lon": 10.84 }, "via": [] }
        """)
        XCTAssertFalse(decoded.hasCourse)
        XCTAssertEqual(decoded.mapPoints.count, 1)
        XCTAssertEqual(decoded.mapPoints.first?.lat, 45.88)
    }

    func testTheCourseWinsOverTheStart() throws {
        let decoded = try route(withCourse)
        XCTAssertEqual(decoded.mapPoints.count, 3)
    }

    func testAnOlderBackendLeavesNothingToDraw() throws {
        // No course and no start: the screen says so instead of
        // showing a map of the open Atlantic.
        XCTAssertTrue(try route(withoutCourse).mapPoints.isEmpty)
    }

    func testTheRelationIdIsReadFromTheRef() throws {
        XCTAssertEqual(try route(withCourse).relationId, 7)
    }

    func testAnythingButARelationHasNoId() throws {
        // A signposted way is a relation; a way or node ref reaching
        // the export would be the wrong kind of thing.
        let decoded = try route(withCourse.replacingOccurrences(of: "relation:7", with: "way:7"))
        XCTAssertNil(decoded.relationId)
    }

    func testTheSpotExtentCarriesTheCourseToo() throws {
        // What the day map draws its solid line from.
        let extent = try JSONDecoder().decode(TripSpotExtent.self, from: Data("""
        { "end": { "lat": 45.92, "lon": 10.84 }, "lengthM": 10000, "ascentM": 600,
          "via": [{ "lat": 45.88, "lon": 10.84 }, { "lat": 45.92, "lon": 10.84 }] }
        """.utf8))
        XCTAssertEqual(extent.via?.count, 2)
    }

    func testAnExtentFromBeforeCoursesStillDecodes() throws {
        let extent = try JSONDecoder().decode(TripSpotExtent.self, from: Data("""
        { "end": { "lat": 45.92, "lon": 10.84 }, "lengthM": 10000, "ascentM": 600 }
        """.utf8))
        XCTAssertNil(extent.via)
        XCTAssertEqual(extent.lengthM, 10_000)
    }
}

/// How far the route search looks (§4.7).
///
/// Three steps, and the end of the scale is not a taste: fifty is the
/// server's limit, so a fourth step would be an option that comes back
/// as an error.
final class TripRouteRadiusTests: XCTestCase {

    func testTheStepsAreTheOnesTheServerAccepts() {
        XCTAssertEqual(TripRouteRadius.allCases.map(\.km), [15, 25, 50])
        XCTAssertEqual(TripRouteRadius.far.km, 50, "50 km is MAX_RADIUS_M in routes.ts")
    }

    func testTheDefaultIsWhatTheSearchDidBefore() {
        // Nobody who never touches the picker should see a different
        // list than they saw yesterday.
        XCTAssertEqual(TripRouteRadius.standard.km, 15)
    }

    func testMetresAreWhatTheRequestCarries() {
        XCTAssertEqual(TripRouteRadius.standard.metres, 15_000)
        XCTAssertEqual(TripRouteRadius.far.metres, 50_000)
    }

    func testTheLabelIsReadable() {
        XCTAssertEqual(TripRouteRadius.wider.label, "25 km")
    }

    func testAStoredNumberNobodyOffersFallsBackRatherThanVanishing() {
        // A value from an older build, or one edited by hand: the
        // picker showing nothing selected would be worse than showing
        // the default.
        XCTAssertEqual(TripRouteRadius.of(km: 25), .wider)
        XCTAssertEqual(TripRouteRadius.of(km: 37), .standard)
        XCTAssertEqual(TripRouteRadius.of(km: 0), .standard)
        XCTAssertEqual(TripRouteRadius.of(km: -5), .standard)
    }
}

/// The file name, which lands in somebody's downloads folder.
final class TripGpxNameTests: XCTestCase {

    func testItIsNamedAfterTheWay() {
        XCTAssertEqual(TripGpxName.file(for: "Panoramaweg Beispiel"),
                       "panoramaweg-beispiel.gpx")
    }

    func testUmlautsSurviveAsLetters() {
        // "K-sseine" would be a worse name than the German one.
        XCTAssertEqual(TripGpxName.file(for: "Kösseine"), "kosseine.gpx")
        XCTAssertEqual(TripGpxName.file(for: "Große Runde"), "grosse-runde.gpx")
    }

    func testRunsOfPunctuationCollapse() {
        XCTAssertEqual(TripGpxName.file(for: "Weg — Runde (2026)"), "weg-runde-2026.gpx")
    }

    func testANameThatIsAllPunctuationStillMakesAFile() {
        XCTAssertEqual(TripGpxName.file(for: "///"), "strecke.gpx")
        XCTAssertEqual(TripGpxName.file(for: "   "), "strecke.gpx")
    }

    func testALongNameStaysAFileName() {
        let name = TripGpxName.file(for: String(repeating: "Weg ", count: 60))
        XCTAssertLessThanOrEqual(name.count, 84)
        XCTAssertTrue(name.hasSuffix(".gpx"))
    }
}
