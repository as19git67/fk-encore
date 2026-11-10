import XCTest
@testable import FKPhotosLib

/// The way between two places (reise-planen-und-unterwegs.md, stage 6).
final class TripWayTests: XCTestCase {
    func testThePolylineDecodes() {
        // Google's own example, five places.
        let points = TripWays.decode("_p~iF~ps|U_ulLnnqC_mqNvxq`@", precision: 5)
        XCTAssertEqual(points.count, 3)
        XCTAssertEqual(points[0].lat, 38.5, accuracy: 1e-6)
        XCTAssertEqual(points[0].lon, -120.2, accuracy: 1e-6)
        XCTAssertEqual(points[2].lat, 43.252, accuracy: 1e-6)
        XCTAssertEqual(points[2].lon, -126.453, accuracy: 1e-6)
        XCTAssertTrue(TripWays.decode("").isEmpty)
    }

    func testWithoutAShapeTheLineIsStraight() {
        let a = TripCoordinate(lat: 48.37, lon: 10.9)
        let b = TripCoordinate(lat: 48.38, lon: 10.91)
        XCTAssertEqual(TripWays.path(shape: nil, from: a, to: b), [a, b])
        let middle = TripWays.midpoint(of: [a, b])!
        XCTAssertEqual(middle.lat, 48.375, accuracy: 1e-6)
        XCTAssertEqual(middle.lon, 10.905, accuracy: 1e-6)
    }

    func testTheWayLineReads() {
        XCTAssertEqual(TripWays.line(minutes: 9, distanceM: 700, by: .foot), "9 min zu Fuß · 700 m")
        XCTAssertEqual(TripWays.distance(2_440), "2,4 km")
        XCTAssertEqual(TripWays.distance(12_600), "13 km")
        XCTAssertEqual(TripWays.capitalized("mit dem Auto"), "Mit dem Auto")
    }

    func testTheArrivalIsChecked() throws {
        let json = """
        {"ways":[{"mode":"car","by":"car","minutes":20,"distanceM":9000,"shape":null,"routed":true,
                  "arriveMinutes":620,"fit":"after_ticket"},
                 {"mode":"foot","by":"foot","minutes":50,"distanceM":3000,"shape":null,"routed":false,
                  "arriveMinutes":650,"fit":"open"}],
         "target":{"openingText":"10:00–18:00","ticketMinutes":615}}
        """
        let response = try JSONDecoder().decode(TripWayResponse.self, from: Data(json.utf8))
        XCTAssertEqual(TripWays.fitText(response.ways[0], target: response.target), "Ankunft ca. 10:20 · zu spät für 10:15")
        XCTAssertTrue(TripWays.isWarning(response.ways[0]))
        XCTAssertEqual(TripWays.fitText(response.ways[1], target: response.target), "Ankunft ca. 10:50 · geöffnet 10:00–18:00")
        XCTAssertFalse(TripWays.isWarning(response.ways[1]))
    }

    func testTheSegmentsStartAtTheStartOfTheDay() {
        let stops = ["node:1", "node:2"].enumerated().map { index, ref in stop(index + 1, ref: ref) }
        let segments = TripWays.segments(of: stops)
        XCTAssertEqual(segments.map(\.fromRef), ["start", "node:1"])
        XCTAssertEqual(segments.map(\.toRef), ["node:1", "node:2"])
    }

    func testAStopIsReachedByThePickedMode() {
        let leg = TripLeg(id: 1, position: 0, title: "Musterstadt",
                          anchor: TripCoordinate(lat: 48.37, lon: 10.9), anchorRadiusM: nil, anchorLabel: nil,
                          arriveMinutes: nil, mode: "transit", regionDb: "nom_test", awaitingRegion: false,
                          startDate: nil, days: [], pool: [])
        XCTAssertEqual(TripWays.mode(of: stop(1, ref: "node:1", travelClass: "short_walk"), leg: leg), .foot)
        XCTAssertEqual(TripWays.mode(of: stop(1, ref: "node:1", travelClass: "long_ride"), leg: leg), .transit)
        XCTAssertEqual(TripWays.mode(of: stop(1, ref: "node:1", wayMode: "car"), leg: leg), .car)
    }

    private func stop(_ id: Int, ref: String, travelClass: String = "short_walk", wayMode: String? = nil) -> TripStop {
        let json = """
        {"rowId":\(id),"osmRef":"\(ref)","name":"Beispielort","lat":48.37,"lon":10.9,"category":"museum",
         "dwellMinutes":60,"travelFromPrevious":{"minutes":10,"distanceM":800,"travelClass":"\(travelClass)"},
         "status":"planned","pinned":false,"note":null,"sourceUrl":null,"title":null,"localName":null,
         "wikipediaUrl":null,"photoStop":false\(wayMode.map { ",\"wayMode\":\"\($0)\"" } ?? "")}
        """
        return try! JSONDecoder().decode(TripStop.self, from: Data(json.utf8))
    }
}
