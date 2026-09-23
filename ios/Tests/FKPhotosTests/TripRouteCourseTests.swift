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

/// Which slice of the map the route search looks in (§4.7).
///
/// A band, not a ceiling: the answer is ordered by distance and
/// capped, so a bigger circle alone hands back the same near ways
/// again. The numbers here have to agree with the server's, because a
/// band it refuses is an error the traveller never asked for.
final class TripRouteBandTests: XCTestCase {

    func testTheBandsTileTheScaleWithoutGaps() {
        // A gap would be ways nobody can reach through any band.
        let bands = TripRouteBand.allCases
        XCTAssertEqual(bands.map(\.fromKm), [0, 20, 35])
        XCTAssertEqual(bands.map(\.toKm), [20, 35, 50])
        for (band, next) in zip(bands, bands.dropFirst()) {
            XCTAssertEqual(band.toKm, next.fromKm, "no gap between \(band) and \(next)")
        }
    }

    func testTheScaleEndsWhereTheServerDoes() {
        XCTAssertEqual(TripRouteBand.far.toKm, 50, "50 km is MAX_RADIUS_M in routes.ts")
    }

    func testTheFirstBandHasNoNearEdge() {
        // Nothing is excluded there, so the request carries no near
        // edge at all — which is what an older backend understands.
        XCTAssertEqual(TripRouteBand.near.fromMetres, 0)
        XCTAssertEqual(TripRouteBand.near.toMetres, 20_000)
    }

    func testMetresAreWhatTheRequestCarries() {
        XCTAssertEqual(TripRouteBand.middle.fromMetres, 20_000)
        XCTAssertEqual(TripRouteBand.middle.toMetres, 35_000)
    }

    func testTheLabelNamesARangeExceptForTheFirst() {
        // "0–20 km" reads like a measurement; "bis 20 km" reads like
        // a choice.
        XCTAssertEqual(TripRouteBand.near.label, "bis 20 km")
        XCTAssertEqual(TripRouteBand.middle.label, "20–35 km")
        XCTAssertEqual(TripRouteBand.far.label, "35–50 km")
    }

    func testAStoredNumberNobodyOffersFallsBackRatherThanVanishing() {
        XCTAssertEqual(TripRouteBand.of(km: 35), .middle)
        XCTAssertEqual(TripRouteBand.of(km: 25), .near, "25 was a radius, not a band")
        XCTAssertEqual(TripRouteBand.of(km: 0), .near)
        XCTAssertEqual(TripRouteBand.of(km: -5), .near)
    }
}

/// The kinds of way, as the filter shows them (§4.7).
final class TripRouteKindTests: XCTestCase {

    func testTheRawValuesAreWhatTheEndpointTakes() {
        // These four strings are the vocabulary in osm2pgsql.lua and
        // in ROUTE_KINDS; a fifth would come back as an error.
        XCTAssertEqual(TripRouteKind.allCases.map(\.rawValue),
                       ["hiking", "foot", "bicycle", "mtb"])
    }

    func testNothingChosenAnnouncesNothing() {
        // A filter that changes nothing should not claim to.
        XCTAssertNil(TripRouteKind.summary(of: []))
    }

    func testEveryKindChosenIsAlsoNothingToAnnounce() {
        XCTAssertNil(TripRouteKind.summary(of: ["hiking", "foot", "bicycle", "mtb"]))
    }

    func testASubsetIsNamed() {
        // Named rather than counted: "2 von 4" says nothing about
        // what is missing.
        XCTAssertEqual(TripRouteKind.summary(of: ["hiking"]), "Wandern")
        XCTAssertEqual(TripRouteKind.summary(of: ["bicycle", "hiking"]),
                       "Wandern, Radfahren")
    }

    func testTheNamesKeepTheOrderOfTheMenu() {
        // Whatever order a Set hands back, the sentence reads the
        // same as the list it describes.
        XCTAssertEqual(TripRouteKind.summary(of: ["mtb", "foot"]),
                       "Spazieren, Mountainbike")
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
