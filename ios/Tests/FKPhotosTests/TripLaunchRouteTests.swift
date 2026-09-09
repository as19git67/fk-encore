import XCTest
@testable import FKPhotosLib

/// Where the app opens (§8.5).
///
/// A rule that fires once, at launch, on somebody else's phone: exactly
/// the kind that is easy to get subtly wrong and impossible to notice.
final class TripLaunchRouteTests: XCTestCase {

    func testTheFeedIsStillTheAnswerForTheOtherFiftyWeeks() {
        XCTAssertFalse(TripLaunchRoute.opensOnTrip(
            tripModeActive: false, planRunningToday: false))
    }

    func testEitherWayOfTravellingCounts() {
        // Trip mode on means the photos are going somewhere; a planned
        // trip whose dates include today means there is a day to stand
        // in. Both are "we are travelling".
        XCTAssertTrue(TripLaunchRoute.opensOnTrip(
            tripModeActive: true, planRunningToday: false))
        XCTAssertTrue(TripLaunchRoute.opensOnTrip(
            tripModeActive: false, planRunningToday: true))
        XCTAssertTrue(TripLaunchRoute.opensOnTrip(
            tripModeActive: true, planRunningToday: true))
    }
}
