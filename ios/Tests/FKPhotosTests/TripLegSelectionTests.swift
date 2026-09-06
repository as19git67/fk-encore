import XCTest
@testable import FKPhotosLib

/// Switching between the cities of a trip (§4.2).
///
/// Every screen behind the day — the pool, the map, moving a spot — is
/// scoped to the leg on screen. So a day view that could not change legs
/// did not merely fail to *show* the other cities; it made them
/// unreachable. What the switch has to get right is which day of the
/// new city to land on, and the answer is the same one opening the trip
/// gives: today when you are there, the first day otherwise.
@MainActor
final class TripLegSelectionTests: XCTestCase {

    private func day(_ index: Int) -> TripDay {
        TripDay(id: 100 + index, dayIndex: index, detailed: true, blocks: [], fixpoints: [])
    }

    private func leg(_ position: Int, _ start: String?, days: Int) -> TripLeg {
        TripLeg(
            id: 10 + position, position: position, title: "Stadt \(position)",
            anchor: TripCoordinate(lat: 48.1, lon: 11.5), anchorRadiusM: nil, anchorLabel: nil, arriveMinutes: nil,
            mode: "foot", regionDb: "nom_test", awaitingRegion: false,
            startDate: start, days: (0..<days).map(day), pool: [])
    }

    /// Tokyo for three days from the 17th, then Osaka for two.
    private func viewModel(today: String) -> TripPlannerViewModel {
        let model = TripPlannerViewModel(planId: 1)
        model.now = { TripCalendar.date(fromIsoDay: today)! }
        model.replace(with: TripPlanResponse(
            plan: TripPlan(
                id: 1, ownerId: 1, title: "Zwei Städte", constraints: nil,
                legs: [leg(0, "2026-09-17", days: 3), leg(1, "2026-09-20", days: 2)]),
            droppedBlocks: nil))
        return model
    }

    func testSwitchingToACityYouAreNotInLandsOnItsFirstDay() {
        let model = viewModel(today: "2026-09-18")
        XCTAssertEqual(model.legIndex, 0)
        XCTAssertEqual(model.dayIndex, 1)

        model.select(leg: 1)

        XCTAssertEqual(model.legIndex, 1)
        XCTAssertEqual(model.dayIndex, 0)
    }

    func testSwitchingToTheCityYouAreInLandsOnToday() {
        // Day two of Osaka. Landing on day one there would be the same
        // mistake as opening a running trip on day one.
        let model = viewModel(today: "2026-09-21")
        model.select(leg: 0)
        XCTAssertEqual(model.dayIndex, 0)

        model.select(leg: 1)

        XCTAssertEqual(model.legIndex, 1)
        XCTAssertEqual(model.dayIndex, 1)
    }

    func testSwitchingBackKeepsWorking() {
        let model = viewModel(today: "2026-09-21")
        model.select(leg: 1)
        model.select(leg: 0)
        XCTAssertEqual(model.legIndex, 0)
        XCTAssertEqual(model.dayIndex, 0)
    }

    func testALegThatIsNotThereChangesNothing() {
        let model = viewModel(today: "2026-09-18")
        model.select(leg: 7)
        XCTAssertEqual(model.legIndex, 0)
        XCTAssertEqual(model.dayIndex, 1)
    }

    func testOpeningARunningTripLandsOnTheCityItIsIn() {
        // The other half of the same rule, and the reason the switch
        // reuses it: on the 21st the trip is in Osaka, not in Tokyo.
        let model = viewModel(today: "2026-09-21")
        XCTAssertEqual(model.legIndex, 1)
        XCTAssertEqual(model.dayIndex, 1)
    }
}
