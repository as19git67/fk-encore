import ActivityKit
import Foundation

/// What a Live Activity says about the day being lived right now (#768 §1).
///
/// Two answers to "where are we" exist and never talk to each other
/// otherwise: `TripDayTimeline.position(in:at:)` says where the plan's
/// own clock puts the group, and `TripVisitMonitor`'s geofences say
/// where a phone actually is. `build(...)` prefers the confirmed stop
/// when one is open and falls back to the plan's guess — an Activity
/// that always trusted the clock would show a museum visit as "over"
/// the moment its budget runs out, even while the group is still
/// inside.
public struct TripDayActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable, Sendable {
        /// The block the day is in right now, or nil once the day's
        /// last block has passed.
        public let blockLabel: String?
        public let blockKind: String?
        /// Minutes past midnight the block is due to end, when the plan
        /// carries block times at all (§8.3 — older plans do not).
        public let blockEndMinutes: Int?
        /// How far the block has run past its own end (§4.7). Zero
        /// when nothing has, which is most of the time.
        public let overrunMinutes: Int
        /// Where the group is, in words: a stop's name, "unterwegs"
        /// between two of them, or nil when the day has not started or
        /// has finished.
        public let currentStopName: String?
        /// True when `currentStopName` came from a geofence
        /// (`TripVisitMonitor`) rather than the plan's clock arithmetic
        /// — the honest signal over the guessed one.
        public let stopConfirmed: Bool
        public let nextStopName: String?
        /// "Goldene Stunde 19:10–19:40", when the current or next stop
        /// has one and it still lies ahead (§7.3). Nil otherwise — a
        /// restated schedule line nobody asked for is noise.
        public let lightHintText: String?

        public init(
            blockLabel: String?,
            blockKind: String?,
            blockEndMinutes: Int?,
            overrunMinutes: Int,
            currentStopName: String?,
            stopConfirmed: Bool,
            nextStopName: String?,
            lightHintText: String?
        ) {
            self.blockLabel = blockLabel
            self.blockKind = blockKind
            self.blockEndMinutes = blockEndMinutes
            self.overrunMinutes = overrunMinutes
            self.currentStopName = currentStopName
            self.stopConfirmed = stopConfirmed
            self.nextStopName = nextStopName
            self.lightHintText = lightHintText
        }
    }

    public let planId: Int
    public let dayTitle: String
}

/// Pure content-state arithmetic — no ActivityKit call in sight, so it is
/// testable without a device. Not `public`: only `TripDayActivityManager`
/// calls it, and its parameters are the package's own (internal) trip
/// models — a public `build` could not mention them.
enum TripDayActivityContent {
    /// Builds the state for `minutes` past midnight, or nil when the day
    /// has nothing to say at that minute (before the first block, after
    /// the last, or a plan with no block times at all — §8.3's honesty
    /// rule: no answer is better than a guessed one).
    ///
    /// - Parameters:
    ///   - confirmedStopName: the name of a stop `TripVisitMonitor` currently
    ///     has an open dwell at, if any. Wins over the plan's own guess.
    static func build(
        day: TripDay,
        at minutes: Int,
        confirmedStopName: String? = nil,
        lightHint: TripDayLight? = nil
    ) -> TripDayActivityAttributes.ContentState? {
        guard let position = TripDayTimeline.position(in: day, at: minutes) else { return nil }
        let block = position.block

        let currentStopName = confirmedStopName ?? position.stop?.displayName
        let nextStopName = position.stopIndex
            .map { $0 + 1 }
            .flatMap { index in
                index < block.stops.count ? block.stops[index].displayName : nil
            }

        let hintStop = position.stop ?? block.stops.first { $0.dwellMinutes > 0 }
        let lightHintText = hintStop.flatMap { lightHint?.hint(for: $0.osmRef)?.best }
            .flatMap { window -> String? in
                guard minutes < window.toMinutes else { return nil }
                return "\(window.label) \(window.range)"
            }

        return TripDayActivityAttributes.ContentState(
            blockLabel: block.label,
            blockKind: block.kind,
            blockEndMinutes: block.endMinutes,
            overrunMinutes: block.overrunMinutes,
            currentStopName: currentStopName,
            stopConfirmed: confirmedStopName != nil,
            nextStopName: nextStopName,
            lightHintText: lightHintText
        )
    }
}
