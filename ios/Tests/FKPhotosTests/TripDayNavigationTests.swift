import XCTest
@testable import FKPhotosLib

/// Moving between the days of a city (§8.3): the picker, a swipe and
/// "Heute" all go through the same two methods, so they cannot drift.
@MainActor
final class TripDayNavigationTests: XCTestCase {

    private func day(_ index: Int) -> TripDay {
        TripDay(id: 100 + index, dayIndex: index, detailed: true, bufferReason: nil,
                blocks: [], fixpoints: [])
    }

    /// One city, three days, starting on the given day.
    private func plan(startDate: String?) -> TripPlan {
        let leg = TripLeg(
            id: 10, position: 0, title: "Beispielstadt",
            anchor: TripCoordinate(lat: 48.1, lon: 11.5), anchorRadiusM: nil,
            anchorLabel: nil, arriveMinutes: nil,
            mode: "foot", regionDb: "nom_test", awaitingRegion: false,
            startDate: startDate, days: (0..<3).map(day), pool: [])
        return TripPlan(id: 1, ownerId: 1, title: "Probe", constraints: nil, legs: [leg])
    }

    private func at(_ iso: String) -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: iso)!
    }

    private func model(startDate: String?, now: String) -> TripPlannerViewModel {
        let vm = TripPlannerViewModel(planId: 1)
        vm.now = { self.at(now) }
        vm.replace(with: TripPlanResponse(plan: plan(startDate: startDate), droppedBlocks: nil))
        return vm
    }

    func testARunningTripOpensOnTodayAndStepsWithinTheCity() {
        // Day 2 of 3 is today.
        let vm = model(startDate: "2026-09-13", now: "2026-09-14T12:00:00Z")
        XCTAssertEqual(vm.dayIndex, 1)
        XCTAssertTrue(vm.isToday)

        vm.step(days: 1)
        XCTAssertEqual(vm.dayIndex, 2)
        vm.step(days: 1)
        XCTAssertEqual(vm.dayIndex, 2, "the last day stays the last day")
        vm.step(days: -1)
        XCTAssertEqual(vm.dayIndex, 1)
    }

    func testSelectingADayThatDoesNotExistChangesNothing() {
        let vm = model(startDate: nil, now: "2026-09-14T12:00:00Z")
        vm.select(dayIndex: 2)
        XCTAssertEqual(vm.dayIndex, 2)
        vm.select(dayIndex: 9)
        XCTAssertEqual(vm.dayIndex, 2)
    }

    func testHeuteLeadsBackToTheDayYouAreOn() {
        let vm = model(startDate: "2026-09-13", now: "2026-09-14T12:00:00Z")
        vm.select(dayIndex: 0)
        XCTAssertFalse(vm.isToday)
        XCTAssertNotNil(vm.todayPosition)

        vm.goToToday()
        XCTAssertEqual(vm.dayIndex, 1)
        XCTAssertTrue(vm.isToday)
    }

    func testAnUndatedTripHasNoToday() {
        let vm = model(startDate: nil, now: "2026-09-14T12:00:00Z")
        XCTAssertNil(vm.todayPosition)
        vm.select(dayIndex: 2)
        vm.goToToday()
        XCTAssertEqual(vm.dayIndex, 2, "nothing to jump to, nothing moves")
    }
}
