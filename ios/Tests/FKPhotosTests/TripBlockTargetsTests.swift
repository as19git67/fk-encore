import XCTest
@testable import FKPhotosLib

/// "Where else could this spot go?" (§8.4)
///
/// One list, shared by the swipe menu, the picker sheet and the spot
/// detail, because three screens with three answers to one question is
/// how an app starts contradicting itself.
final class TripBlockTargetsTests: XCTestCase {

    private func block(_ id: String, kind: String = "spots", budget: Int = 180, used: Int = 0) -> TripBlock {
        TripBlock(
            id: id, rowId: id.hashValue, label: id.capitalized, kind: kind,
            budgetMinutes: budget, usedMinutes: used, startMinutes: nil, stops: [],
            branches: nil)
    }

    private func day(_ index: Int, detailed: Bool = true, blocks: [TripBlock]) -> TripDay {
        TripDay(id: 100 + index, dayIndex: index, detailed: detailed, bufferReason: nil, blocks: blocks, fixpoints: [])
    }

    private func leg(_ days: [TripDay]) -> TripLeg {
        TripLeg(
            id: 1, position: 0, title: "Stadt",
            anchor: TripCoordinate(lat: 48.1, lon: 11.5), anchorRadiusM: nil,
            anchorLabel: nil, arriveMinutes: nil, mode: "foot", regionDb: "nom_test",
            awaitingRegion: false, startDate: "2026-09-17", days: days, pool: [])
    }

    private var twoDays: TripLeg {
        leg([
            day(0, blocks: [block("morning"), block("midday", kind: "meal"), block("afternoon")]),
            day(1, blocks: [block("morning"), block("afternoon")]),
            day(2, detailed: false, blocks: [block("morning")]),
        ])
    }

    func testAMealBlockIsNeverAPlaceForASpot() {
        // A meal block holds time and a rough area, never a venue
        // (§10.3).
        let ids = TripBlockTargets.all(in: twoDays).map(\.blockId)
        XCTAssertFalse(ids.contains("midday"))
    }

    func testADayAtTripResolutionCannotReceiveAnything() {
        // It has a frame and no stops yet (§4.3).
        XCTAssertFalse(TripBlockTargets.all(in: twoDays).contains { $0.dayIndex == 2 })
    }

    func testTheBlockTheSpotIsAlreadyInIsNotOffered() {
        // An option that does nothing is a wrong answer to "where
        // else?" — this was the bug in the move menu.
        let targets = TripBlockTargets.all(
            in: twoDays, excluding: (dayIndex: 0, blockId: "morning"))

        XCTAssertFalse(targets.contains { $0.dayIndex == 0 && $0.blockId == "morning" })
        // The same block on another day is a different place and stays.
        XCTAssertTrue(targets.contains { $0.dayIndex == 1 && $0.blockId == "morning" })
        XCTAssertTrue(targets.contains { $0.dayIndex == 0 && $0.blockId == "afternoon" })
    }

    func testWithoutALegThereIsNowhereToGo() {
        XCTAssertEqual(TripBlockTargets.all(in: nil).count, 0)
    }

    func testAnOverfullBlockIsOfferedAndSaysSo() {
        // Shown, not prevented: the traveller drops it there on purpose
        // and the block turns red (§8.4).
        let full = leg([day(0, blocks: [block("morning", budget: 120, used: 200)])])
        let target = TripBlockTargets.all(in: full).first

        XCTAssertEqual(target?.freeMinutes, -80)
        XCTAssertEqual(target?.isOverfull, true)
    }

    func testOneDayAtATimeForTheScreensThatGroupByDay() {
        let targets = TripBlockTargets.ofDay(1, in: twoDays)
        XCTAssertEqual(targets.map(\.blockId), ["morning", "afternoon"])
        XCTAssertTrue(targets.allSatisfy { $0.dayIndex == 1 })
    }
}
