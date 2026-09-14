import XCTest
@testable import FKPhotosLib

/// Which half of the Trip tab opens (§8.1).
///
/// Like the launch route, it fires once and on somebody else's phone.
final class TripTabModeTests: XCTestCase {

    func testTheHalfYouLeftIsTheHalfYouComeBackTo() {
        XCTAssertEqual(
            TripTabMode.initial(tripModeActive: false, planRunningToday: false, remembered: .plan),
            .plan)
        XCTAssertEqual(
            TripTabMode.initial(tripModeActive: false, planRunningToday: false, remembered: .capture),
            .capture)
    }

    func testAPlannedTripRunningTodayOpensOnItsDay() {
        // No photos going anywhere, but a day to stand in: the plan is
        // what is wanted, not an empty grid with a banner.
        XCTAssertEqual(
            TripTabMode.initial(tripModeActive: false, planRunningToday: true, remembered: .capture),
            .plan)
    }

    func testTripModeWinsBecauseItsScreenCarriesThePlanAnyway() {
        XCTAssertEqual(
            TripTabMode.initial(tripModeActive: true, planRunningToday: true, remembered: .plan),
            .capture)
        XCTAssertEqual(
            TripTabMode.initial(tripModeActive: true, planRunningToday: false, remembered: .plan),
            .capture)
    }

    func testTheStoredValueSurvivesARoundTrip() {
        for mode in TripTabMode.allCases {
            XCTAssertEqual(TripTabMode(rawValue: mode.rawValue), mode)
        }
    }
}
