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
    ///     never a venue (§10.3) — dropping a museum in would quietly
    ///     make the block something it is not.
    ///   - **Days at trip resolution**, which have a frame and no stops
    ///     yet (§4.3): the day has to be planned before it can receive.
    ///   - **The block the stop already sits in.** Offering it is an
    ///     option that does nothing, and an option that does nothing is
    ///     a wrong answer to "where else".
    static func all(
        in leg: TripLeg?,
        excluding current: (dayIndex: Int, blockId: String)? = nil,
    ) -> [TripBlockTarget] {
        guard let leg else { return [] }
        return leg.days
            .filter(\.detailed)
            .flatMap { day in
                day.blocks.compactMap { block -> TripBlockTarget? in
                    guard block.kind == "spots" else { return nil }
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
    ) -> [TripBlockTarget] {
        all(in: leg, excluding: current).filter { $0.dayIndex == dayIndex }
    }
}
