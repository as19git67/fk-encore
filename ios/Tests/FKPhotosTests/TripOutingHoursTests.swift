import XCTest
@testable import FKPhotosLib

/// The two hours a day trip may name (§4.5).
///
/// They exist because the estimate cannot be right: without a routing
/// engine the drive is a straight line with a factor on it, which read
/// eight and a half hours for a trip that takes three. The traveller
/// knows better, so the app lets them say so — and the arithmetic that
/// follows is small enough to get wrong quietly, hence these.
final class TripOutingHoursTests: XCTestCase {

    func testOneHourOnItsOwnIsAlwaysFine() {
        // "We leave at eight" says nothing about coming back.
        XCTAssertTrue(TripOutingHours.addUp(depart: 8 * 60, back: nil))
        XCTAssertTrue(TripOutingHours.addUp(depart: nil, back: 17 * 60))
        XCTAssertTrue(TripOutingHours.addUp(depart: nil, back: nil))
    }

    func testAReturnBeforeTheDepartureDoesNotAddUp() {
        XCTAssertFalse(TripOutingHours.addUp(depart: 16 * 60, back: 9 * 60))
        // Nor the same minute: a day trip that comes back the instant
        // it leaves is a day with no day in it.
        XCTAssertFalse(TripOutingHours.addUp(depart: 9 * 60, back: 9 * 60))
        XCTAssertTrue(TripOutingHours.addUp(depart: 9 * 60, back: 9 * 60 + 1))
    }

    func testTheArrivalShowsTheDriveItAdded() {
        // Shown rather than folded into a shorter afternoon: the drive
        // is the one part still guessed, and a visible guess is one the
        // traveller can correct.
        XCTAssertEqual(TripOutingHours.arrival(departMinutes: 8 * 60, travelMinutes: 82),
                       "09:22 (+ 1 h 22 Fahrt)")
    }

    func testItInventsNothingWithoutBothHalves() {
        XCTAssertNil(TripOutingHours.arrival(departMinutes: nil, travelMinutes: 82))
        XCTAssertNil(TripOutingHours.arrival(departMinutes: 8 * 60, travelMinutes: nil))
        XCTAssertNil(TripOutingHours.arrival(departMinutes: 8 * 60, travelMinutes: 0))
    }
}
