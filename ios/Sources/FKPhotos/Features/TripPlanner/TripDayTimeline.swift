import Foundation

/// "Where would we be at this hour?" — the arithmetic behind the time
/// slider of §8.3.
///
/// The concept's point about the slider is that it turns a claim into
/// something checkable: the light hint says "best around 19:30", and the
/// slider shows whether the plan actually has you there then. That only
/// works if the answer is honest at both ends — including when there is
/// no answer.
///
/// So this returns `nil` rather than a nearest guess when the hour falls
/// outside the day, or when the plan carries no block times at all
/// (which is every plan written before they were kept). A slider that
/// always points somewhere would make the one thing it exists to check
/// impossible to fail.
///
/// Pure and free of dates: minutes past midnight in, a position out.
enum TripDayTimeline {

    /// Where the plan has the travellers at `minutes`, if anywhere.
    ///
    /// Within a block, the stops are spread across it in order — the
    /// plan knows the sequence and the dwell times but not the clock
    /// time of each stop, and pretending otherwise would be a precision
    /// the planner never claimed (§4.1). A block with no stops still
    /// answers, with the block itself: "Mittag, irgendwo hier".
    static func position(in day: TripDay, at minutes: Int) -> TripTimelinePosition? {
        guard let block = block(in: day, at: minutes) else { return nil }
        guard let start = block.startMinutes, !block.stops.isEmpty else {
            return TripTimelinePosition(block: block, stop: nil, stopIndex: nil)
        }

        // Share the block's span between its stops, in order. Each stop
        // gets the slice its dwell time earns it, so ninety minutes in a
        // museum reads as ninety minutes in a museum.
        let total = block.stops.reduce(0) { $0 + $1.dwellMinutes + $1.travelFromPrevious.minutes }
        guard total > 0 else {
            return TripTimelinePosition(block: block, stop: block.stops.first, stopIndex: 0)
        }

        let elapsed = minutes - start
        var cursor = 0
        for (index, stop) in block.stops.enumerated() {
            cursor += stop.dwellMinutes + stop.travelFromPrevious.minutes
            // Scale against the block's real span, which may be longer
            // than the stops use — an unfilled block leaves the last one
            // standing until the block ends, which is what happens.
            let boundary = block.budgetMinutes > 0
                ? Int((Double(cursor) / Double(total)) * Double(min(total, block.budgetMinutes)))
                : cursor
            if elapsed < boundary || index == block.stops.count - 1 {
                return TripTimelinePosition(block: block, stop: stop, stopIndex: index)
            }
        }
        return TripTimelinePosition(block: block, stop: block.stops.last, stopIndex: block.stops.count - 1)
    }

    /// The block covering `minutes`, or nil outside the day.
    static func block(in day: TripDay, at minutes: Int) -> TripBlock? {
        day.blocks.first { block in
            guard let start = block.startMinutes else { return false }
            return minutes >= start && minutes < start + max(block.budgetMinutes, 1)
        }
    }

    /// How much of `block` is left at `minutes` — what a redistribution
    /// is told it has to work with (§5).
    ///
    /// Zero rather than a negative number when the block is already
    /// over: "we are out of time" is the true statement, and a negative
    /// budget would have the solver plan backwards.
    static func remainingMinutes(of block: TripBlock, at minutes: Int) -> Int {
        guard let start = block.startMinutes else { return block.budgetMinutes }
        return max(0, start + block.budgetMinutes - minutes)
    }

    /// Minutes past midnight for a wall-clock instant, in the device's
    /// own timezone — which is the one the traveller is standing in.
    static func minutesOfDay(_ date: Date, calendar: Calendar = .current) -> Int {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
    }

    /// The span the slider should cover: the first block's start to the
    /// last one's end. Nil when no block carries an hour.
    static func span(of day: TripDay) -> ClosedRange<Int>? {
        let starts = day.blocks.compactMap(\.startMinutes)
        let ends = day.blocks.compactMap(\.endMinutes)
        guard let first = starts.min(), let last = ends.max(), first < last else { return nil }
        return first...last
    }
}

/// Where the plan puts the travellers at one hour of the day.
struct TripTimelinePosition: Equatable {
    let block: TripBlock
    /// The stop they would be at, or nil for a block that holds time
    /// rather than places — a meal block, or one nothing was planned in.
    let stop: TripStop?
    /// Position of `stop` within the block, for the map's numbering.
    let stopIndex: Int?

    static func == (lhs: TripTimelinePosition, rhs: TripTimelinePosition) -> Bool {
        lhs.block.id == rhs.block.id && lhs.stop?.rowId == rhs.stop?.rowId
    }
}
