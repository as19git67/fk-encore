import XCTest
@testable import FKPhotosLib

/// How far a day reaches, per mode (§4.2).
///
/// Written after a week in San Francisco came back as the four streets
/// around the hotel. The screen sends an explicit radius with every
/// leg, so the server's own default never applies to a trip made in the
/// app — three kilometres is a walking radius around a European old
/// town, and the bridge is six kilometres out.
final class TripReachTests: XCTestCase {

    func testAVehicleReachesAcrossACity() {
        XCTAssertEqual(TripReach.radius(for: .foot), 3_000)
        XCTAssertGreaterThan(TripReach.radius(for: .bike), TripReach.radius(for: .foot))
        XCTAssertGreaterThan(TripReach.radius(for: .transit), TripReach.radius(for: .bike))
        XCTAssertGreaterThanOrEqual(TripReach.radius(for: .car), 20_000)
    }

    func testNoModeAsksForMoreThanTheServiceWillSearch() {
        for mode in TripTransportMode.allCases {
            XCTAssertLessThanOrEqual(TripReach.radius(for: mode), TripReach.maxRadiusM)
            XCTAssertGreaterThanOrEqual(TripReach.radius(for: mode), TripReach.minRadiusM)
        }
    }

    func testChangingTheModeMovesARadiusNobodyTouched() {
        let moved = TripReach.radius(movingFrom: .foot, to: .car,
                                     current: TripReach.radius(for: .foot))
        XCTAssertEqual(moved, TripReach.radius(for: .car))
    }

    func testARadiusSomebodySetByHandSurvivesTheModeChanging() {
        // A number somebody chose is an answer; overwriting it because
        // they then picked "mit dem Auto" throws away the more specific
        // of the two statements.
        XCTAssertEqual(TripReach.radius(movingFrom: .foot, to: .car, current: 1_200), 1_200)
    }

    func testTheDraftFollowsTheModeItIsGiven() {
        var leg = TripDraftLeg()
        XCTAssertEqual(leg.radiusM, TripReach.radius(for: .foot))
        leg.mode = .car
        XCTAssertEqual(leg.radiusM, TripReach.radius(for: .car))
        // And back again: still nobody has typed a number.
        leg.mode = .foot
        XCTAssertEqual(leg.radiusM, TripReach.radius(for: .foot))
    }

    func testTheDraftKeepsAHandPickedRadiusAcrossAModeChange() {
        var leg = TripDraftLeg()
        leg.radiusM = 750
        leg.mode = .transit
        XCTAssertEqual(leg.radiusM, 750)
    }
}
