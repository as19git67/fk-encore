import XCTest
@testable import FKPhotosLib

/// Routes as a chip of the spot picker (reise-planen-und-unterwegs.md, stage 7, step 4).
final class TripStayRoutesTests: XCTestCase {
    func testTheLineLeadsWithTheDuration() {
        let route = TripNearbyRoute(osmRef: "relation:1", name: "Panoramaweg Beispiel", route: "hiking",
                                    network: nil, ref: nil, lengthM: 10_000, ascentM: 600, distanceM: 2_000,
                                    estimatedMinutes: 210, roundtrip: true, joined: true, website: nil,
                                    difficulty: nil, inPool: false)
        XCTAssertEqual(TripStayRoutesText.line(route), "3 h 30 · 10 km · 600 Hm · Rundweg")
    }
}
