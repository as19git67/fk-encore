import Foundation

/// One block a spot could be moved into (§8.4).
///
/// Flattened across the days of a leg on purpose: "where else could
/// this go" is one question, and every screen that asks it — the swipe
/// menu, the picker sheet, the spot detail — has to answer it the same
/// way or the app grows three opinions about the same move.
struct TripBlockTarget: Identifiable, Equatable {
    let dayIndex: Int
    let blockId: String
    let label: String
    /// What is left of the block's budget. Negative when it is over,
    /// which is shown rather than prevented (§8.4).
    let freeMinutes: Int

    var id: String { "\(dayIndex)/\(blockId)" }
    var isOverfull: Bool { freeMinutes < 0 }
}

enum TripBlockTargets {
    /// Every block of the leg a stop can be dropped into.
    ///
    /// Three things are left out, each for its own reason:
    ///
    ///   - **Meal blocks**, because they hold time and a rough area,
    ///     never a sight (§10.3) — dropping a museum in would quietly
    ///     make the block something it is not. Somewhere to eat is
    ///     what the block is for, so for a restaurant or a café they
    ///     are offered, and the sightseeing blocks are not for a
    ///     restaurant: it is a meal, not a sight.
    ///   - **Days at trip resolution**, which have a frame and no stops
    ///     yet (§4.3): the day has to be planned before it can receive.
    ///   - **The block the stop already sits in.** Offering it is an
    ///     option that does nothing, and an option that does nothing is
    ///     a wrong answer to "where else".
    ///   - **What is already over**, once a `now` is given and the trip
    ///     has dates: yesterday, and the blocks of today the clock has
    ///     passed. Out of the first trial — on day two the picker still
    ///     offered day one. Moving a spot into the past is not a plan.
    ///     A trip without dates has no past and keeps every block.
    /// What a meal block may hold — the same two the server names.
    static let mealCategories: Set<String> = ["food", "cafe"]

    /// Whether a spot of this category may go into this kind of block.
    static func fits(category: String?, blockKind: String) -> Bool {
        let eats = category.map { mealCategories.contains($0) } ?? false
        if blockKind == "meal" { return eats }
        // A restaurant is a meal, not a sight; a café can be an
        // afternoon's stop.
        return category != "food"
    }

    static func all(
        in leg: TripLeg?,
        excluding current: (dayIndex: Int, blockId: String)? = nil,
        now: Date? = nil,
        category: String? = nil,
    ) -> [TripBlockTarget] {
        guard let leg else { return [] }
        let today = now.flatMap { todayIndex(in: leg, now: $0) }
        let minutes = now.map { TripDayTimeline.minutesOfDay($0) }
        return leg.days
            .filter(\.detailed)
            .filter { day in today.map { day.dayIndex >= $0 } ?? true }
            .flatMap { day in
                day.blocks.compactMap { block -> TripBlockTarget? in
                    guard fits(category: category, blockKind: block.kind) else { return nil }
                    if let today, let minutes, day.dayIndex == today,
                       let end = block.endMinutes, end <= minutes {
                        return nil
                    }
                    if let current, current.dayIndex == day.dayIndex, current.blockId == block.id {
                        return nil
                    }
                    return TripBlockTarget(
                        dayIndex: day.dayIndex,
                        blockId: block.id,
                        label: block.label,
                        freeMinutes: block.budgetMinutes - block.usedMinutes,
                    )
                }
            }
    }

    /// The targets of one day, for a screen that groups them by day.
    static func ofDay(
        _ dayIndex: Int,
        in leg: TripLeg?,
        excluding current: (dayIndex: Int, blockId: String)? = nil,
        now: Date? = nil,
        category: String? = nil,
    ) -> [TripBlockTarget] {
        all(in: leg, excluding: current, now: now, category: category).filter { $0.dayIndex == dayIndex }
    }

    /// Which day of the leg `now` falls on, or nil for a trip without
    /// dates — which has no today and therefore no yesterday.
    static func todayIndex(in leg: TripLeg, now: Date, timeZone: TimeZone = .current) -> Int? {
        guard let start = leg.startDate else { return nil }
        return TripCalendar.days(from: start, to: TripCalendar.isoDay(now, timeZone: timeZone), timeZone: timeZone)
    }

    /// Is this day already behind the traveller? False for a trip
    /// without dates.
    static func isPast(_ dayIndex: Int, in leg: TripLeg, now: Date, timeZone: TimeZone = .current) -> Bool {
        guard let today = todayIndex(in: leg, now: now, timeZone: timeZone) else { return false }
        return dayIndex < today
    }
}
