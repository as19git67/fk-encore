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

    // MARK: - What is already over

    private func at(_ day: String, _ hour: Int, _ minute: Int = 0) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let date = TripCalendar.date(fromIsoDay: day, timeZone: .current)!
        return calendar.date(bySettingHour: hour, minute: minute, second: 0, of: date)!
    }

    private var timedTwoDays: TripLeg {
        let timed = { (id: String, start: Int) in
            TripBlock(id: id, rowId: id.hashValue, label: id.capitalized, kind: "spots",
                      budgetMinutes: 180, usedMinutes: 0, startMinutes: start, stops: [], branches: nil)
        }
        return leg([
            day(0, blocks: [timed("morning", 9 * 60), timed("afternoon", 14 * 60)]),
            day(1, blocks: [timed("morning", 9 * 60), timed("afternoon", 14 * 60)]),
            day(2, blocks: [timed("morning", 9 * 60), timed("afternoon", 14 * 60)]),
        ])
    }

    func testYesterdayIsNotAPlaceASpotCanGo() {
        // The trial's complaint: on day two the picker still offered
        // day one.
        let targets = TripBlockTargets.all(in: timedTwoDays, now: at("2026-09-18", 10))
        XCTAssertFalse(targets.contains { $0.dayIndex == 0 })
        XCTAssertTrue(targets.contains { $0.dayIndex == 1 })
        XCTAssertTrue(targets.contains { $0.dayIndex == 2 })
        XCTAssertTrue(TripBlockTargets.isPast(0, in: timedTwoDays, now: at("2026-09-18", 10)))
        XCTAssertFalse(TripBlockTargets.isPast(1, in: timedTwoDays, now: at("2026-09-18", 10)))
    }

    func testABlockTodayTheClockHasPassedIsGoneToo() {
        // 15:00 on day two: the morning ended at noon, the afternoon is
        // still on.
        let today = TripBlockTargets.ofDay(1, in: timedTwoDays, now: at("2026-09-18", 15))
        XCTAssertEqual(today.map(\.blockId), ["afternoon"])
        // At 17:00 the afternoon (14:00–17:00) is over as well.
        XCTAssertEqual(TripBlockTargets.ofDay(1, in: timedTwoDays, now: at("2026-09-18", 17)).count, 0)
    }

    func testTomorrowKeepsEveryBlock() {
        let tomorrow = TripBlockTargets.ofDay(2, in: timedTwoDays, now: at("2026-09-18", 17))
        XCTAssertEqual(tomorrow.map(\.blockId), ["morning", "afternoon"])
    }

    func testATripWithoutDatesHasNoPast() {
        // No date, no today, no yesterday: every block stays.
        let undated = TripLeg(
            id: 1, position: 0, title: "Stadt",
            anchor: TripCoordinate(lat: 48.1, lon: 11.5), anchorRadiusM: nil,
            anchorLabel: nil, arriveMinutes: nil, mode: "foot", regionDb: "nom_test",
            awaitingRegion: false, startDate: nil, days: timedTwoDays.days, pool: [])
        XCTAssertEqual(TripBlockTargets.all(in: undated, now: at("2026-09-18", 17)).count, 6)
        XCTAssertNil(TripBlockTargets.todayIndex(in: undated, now: at("2026-09-18", 17)))
    }

    func testWithoutANowNothingIsPast() {
        // The pure list as every other caller had it.
        XCTAssertEqual(TripBlockTargets.all(in: timedTwoDays).count, 6)
    }

    func testOneDayAtATimeForTheScreensThatGroupByDay() {
        let targets = TripBlockTargets.ofDay(1, in: twoDays)
        XCTAssertEqual(targets.map(\.blockId), ["morning", "afternoon"])
        XCTAssertTrue(targets.allSatisfy { $0.dayIndex == 1 })
    }
}
