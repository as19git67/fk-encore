import XCTest
@testable import FKPhotosLib

/// "Where would we be at this hour?" — the arithmetic behind the time
/// slider (§8.3).
///
/// The slider exists to turn a claim into something checkable: the light
/// hint says "best around 19:30", and the slider shows whether the plan
/// actually has you there then. That only works if it is honest when it
/// has no answer — a slider that always points somewhere makes the one
/// thing it exists to check impossible to fail. So most of these tests
/// are about the cases where the answer is nil.
final class TripDayTimelineTests: XCTestCase {

    private func stop(_ id: Int, dwell: Int, travel: Int = 0) -> TripStop {
        TripStop(
            rowId: id,
            osmRef: "node:\(id)",
            name: "Spot \(id)",
            lat: 48.37,
            lon: 10.9,
            category: "sight",
            dwellMinutes: dwell,
            travelFromPrevious: TripTravel(minutes: travel, distanceM: travel * 75, travelClass: "short_walk"),
            status: "planned",
            pinned: false,
            note: nil,
            sourceUrl: nil,
            title: nil,
            localName: nil,
            wikipediaUrl: nil,
        )
    }

    private func block(
        _ id: String,
        start: Int?,
        budget: Int,
        kind: String = "spots",
        stops: [TripStop] = [],
    ) -> TripBlock {
        TripBlock(
            id: id,
            rowId: id.hashValue,
            label: id,
            kind: kind,
            budgetMinutes: budget,
            usedMinutes: stops.reduce(0) { $0 + $1.dwellMinutes + $1.travelFromPrevious.minutes },
            startMinutes: start,
            stops: stops,
        )
    }

    private func day(_ blocks: [TripBlock]) -> TripDay {
        TripDay(id: 1, dayIndex: 0, detailed: true, blocks: blocks, fixpoints: [])
    }

    /// 09:00 morning with two stops, 12:30 meal, 14:00 afternoon.
    private var sampleDay: TripDay {
        day([
            block("morning", start: 9 * 60, budget: 210, stops: [
                stop(1, dwell: 90),
                stop(2, dwell: 60, travel: 10),
            ]),
            block("midday", start: 12 * 60 + 30, budget: 90, kind: "meal"),
            block("afternoon", start: 14 * 60, budget: 210, stops: [stop(3, dwell: 45)]),
        ])
    }

    // MARK: - The span the slider covers

    func testSpanRunsFromFirstBlockToLast() throws {
        let span = try XCTUnwrap(TripDayTimeline.span(of: sampleDay))
        XCTAssertEqual(span.lowerBound, 9 * 60)
        XCTAssertEqual(span.upperBound, 14 * 60 + 210)
    }

    func testNoSpanWithoutBlockTimes() {
        // Every plan written before block times were kept lands here.
        // Making up a span would put the marker somewhere the traveller
        // was never planned to be.
        let old = day([block("morning", start: nil, budget: 210, stops: [stop(1, dwell: 60)])])
        XCTAssertNil(TripDayTimeline.span(of: old))
        XCTAssertNil(TripDayTimeline.position(in: old, at: 10 * 60))
    }

    func testNoSpanForADayWithNoBlocks() {
        XCTAssertNil(TripDayTimeline.span(of: day([])))
    }

    // MARK: - Where the plan puts you

    func testFindsTheBlockCoveringAnHour() throws {
        let position = try XCTUnwrap(TripDayTimeline.position(in: sampleDay, at: 10 * 60))
        XCTAssertEqual(position.block.id, "morning")
    }

    func testAnswersWithTheBlockWhenItHoldsTimeRatherThanPlaces() throws {
        // A meal block is time plus a rough area, never a venue (§10.3),
        // so "Mittag" is the whole answer.
        let position = try XCTUnwrap(TripDayTimeline.position(in: sampleDay, at: 13 * 60))
        XCTAssertEqual(position.block.id, "midday")
        XCTAssertNil(position.stop)
    }

    func testSpreadsTheBlockAcrossItsStopsInOrder() throws {
        // Ninety minutes in the first spot then an hour in the second:
        // the slider should not jump to the second at 09:05.
        let early = try XCTUnwrap(TripDayTimeline.position(in: sampleDay, at: 9 * 60 + 30))
        XCTAssertEqual(early.stop?.rowId, 1)

        let late = try XCTUnwrap(TripDayTimeline.position(in: sampleDay, at: 12 * 60))
        XCTAssertEqual(late.stop?.rowId, 2)
    }

    func testLeavesTheLastStopStandingUntilTheBlockEnds() throws {
        // The morning's stops use 160 of its 210 minutes. The remaining
        // fifty are not "nowhere" — you are still at the last spot.
        let position = try XCTUnwrap(TripDayTimeline.position(in: sampleDay, at: 12 * 60 + 20))
        XCTAssertEqual(position.block.id, "morning")
        XCTAssertEqual(position.stop?.rowId, 2)
    }

    // MARK: - Being honest about having no answer

    func testSaysNothingBeforeTheDayStarts() {
        XCTAssertNil(TripDayTimeline.position(in: sampleDay, at: 7 * 60))
    }

    func testSaysNothingAfterTheDayEnds() {
        XCTAssertNil(TripDayTimeline.position(in: sampleDay, at: 22 * 60))
    }

    func testSaysNothingInAGapBetweenBlocks() {
        // A day whose afternoon was pushed back by a booked tour has a
        // real hole in it. Pointing at the nearest block would claim the
        // travellers are somewhere the plan never put them.
        let gapped = day([
            block("morning", start: 9 * 60, budget: 120, stops: [stop(1, dwell: 60)]),
            block("afternoon", start: 15 * 60, budget: 120, stops: [stop(2, dwell: 60)]),
        ])
        XCTAssertNil(TripDayTimeline.position(in: gapped, at: 13 * 60))
        XCTAssertNotNil(TripDayTimeline.position(in: gapped, at: 15 * 60 + 30))
    }

    func testTheBoundaryBelongsToTheBlockThatStartsThere() throws {
        // Two blocks meet at 12:30. The hour has to belong to exactly
        // one of them, or the marker flickers between two places.
        let position = try XCTUnwrap(TripDayTimeline.position(in: sampleDay, at: 12 * 60 + 30))
        XCTAssertEqual(position.block.id, "midday")
    }

    func testAnEmptyBlockStillAnswersWithItself() throws {
        let empty = day([block("evening", start: 18 * 60, budget: 120)])
        let position = try XCTUnwrap(TripDayTimeline.position(in: empty, at: 19 * 60))
        XCTAssertEqual(position.block.id, "evening")
        XCTAssertNil(position.stop)
    }

    // MARK: - What a redistribution is told it has to work with

    func testRemainingMinutesCountsDownWithinTheBlock() {
        // Morning 09:00 + 210 min ends at 12:30 (750).
        let morning = block("morning", start: 9 * 60, budget: 210)
        XCTAssertEqual(TripDayTimeline.remainingMinutes(of: morning, at: 9 * 60), 210)
        XCTAssertEqual(TripDayTimeline.remainingMinutes(of: morning, at: 10 * 60), 150)
        XCTAssertEqual(TripDayTimeline.remainingMinutes(of: morning, at: 12 * 60 + 29), 1)
        XCTAssertEqual(TripDayTimeline.remainingMinutes(of: morning, at: 12 * 60 + 30), 0)
    }

    func testAnOverrunBlockHasNoTimeLeftRatherThanNegativeTime() {
        // "We are out of time" is the true statement. A negative budget
        // would have the solver plan backwards.
        let short = block("morning", start: 9 * 60, budget: 60)
        XCTAssertEqual(TripDayTimeline.remainingMinutes(of: short, at: 11 * 60), 0)
    }

    func testABlockWithoutAnHourReportsItsWholeBudget() {
        // Nothing is known about where the day stands, so nothing is
        // subtracted — better than pretending the block is half gone.
        let old = block("morning", start: nil, budget: 210)
        XCTAssertEqual(TripDayTimeline.remainingMinutes(of: old, at: 12 * 60), 210)
    }

    func testMinutesOfDayReadsTheWallClock() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Berlin")!
        var parts = DateComponents()
        parts.year = 2026; parts.month = 9; parts.day = 4
        parts.hour = 18; parts.minute = 40
        let date = calendar.date(from: parts)!

        XCTAssertEqual(TripDayTimeline.minutesOfDay(date, calendar: calendar), 18 * 60 + 40)
    }

    func testMidnightIsZeroNotFourteenFourty() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Berlin")!
        var parts = DateComponents()
        parts.year = 2026; parts.month = 9; parts.day = 4
        parts.hour = 0; parts.minute = 0
        XCTAssertEqual(
            TripDayTimeline.minutesOfDay(calendar.date(from: parts)!, calendar: calendar), 0,
        )
    }
}
