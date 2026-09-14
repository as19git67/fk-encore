import XCTest
@testable import FKPhotosLib

/// One view model per plan (plan item X10), so the day somebody was
/// looking at survives going back to the list.
@MainActor
final class TripPlannerViewModelCacheTests: XCTestCase {

    override func tearDown() {
        TripPlannerViewModel.forget(planId: 4101)
        TripPlannerViewModel.forget(planId: 4102)
        super.tearDown()
    }

    func testTheSamePlanGetsTheSameModel() {
        let first = TripPlannerViewModel.shared(for: 4101)
        first.dayIndex = 3

        let again = TripPlannerViewModel.shared(for: 4101)

        XCTAssertTrue(first === again)
        XCTAssertEqual(again.dayIndex, 3)
    }

    func testDifferentPlansDoNotShareAModel() {
        XCTAssertFalse(TripPlannerViewModel.shared(for: 4101) === TripPlannerViewModel.shared(for: 4102))
    }

    func testForgettingStartsOver() {
        let first = TripPlannerViewModel.shared(for: 4101)
        TripPlannerViewModel.forget(planId: 4101)

        XCTAssertFalse(first === TripPlannerViewModel.shared(for: 4101))
    }
}
