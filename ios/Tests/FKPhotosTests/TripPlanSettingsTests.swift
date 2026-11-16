import XCTest
@testable import FKPhotosLib

/// What the settings screen sends (§6.2). The date is not one of
/// them any more: it belongs to the first stay in the itinerary.
@MainActor
final class TripPlanSettingsTests: XCTestCase {
    func testTheVoteStartsAsTheTripHasIt() {
        let m = TripPlanSettingsViewModel(planId: 1, constraints: nil, title: "Reise")
        XCTAssertEqual(m.title, "Reise")
        XCTAssertTrue(m.voting)
    }
}

/// The mode as the traveller reads it.
final class TripTransportModeLabelTests: XCTestCase {
    func testTransitDoesNotPromiseNeverToWalk() {
        // The planner walks any hop that is quicker on foot, which in an
        // old town is most of them. "Mit Öffentlichen" described a leg
        // that does not exist.
        XCTAssertEqual(TripTransportMode.transit.label, "ÖPNV & zu Fuß")
    }

    func testEveryModeSaysWhatItDoesToThePlan() {
        for mode in TripTransportMode.allCases {
            XCTAssertFalse(mode.hint.isEmpty)
            XCTAssertNotEqual(mode.label, mode.rawValue)
        }
    }
}
