import Foundation

/// Where a day actually begins and ends (§4.4).
///
/// The anchor is the accommodation, and for an ordinary day it is both.
/// Two days of a trip are not ordinary, and they are the two everybody
/// remembers: on the first you arrive at a station with luggage, on the
/// last the train leaves from one. A fixpoint that names a **place**
/// says so, and the planner routes the day from and to it.
///
/// Mirrors `trip-planner/day-ends.ts`, which is the authority — this
/// side only says what the plan already did, so the screen can name the
/// two ends instead of leaving them to be deduced from a map pin.
enum TripDayEnds {
    struct Ends: Equatable {
        /// The fixpoint the day sets off from, or nil for the anchor.
        let start: TripFixpoint?
        /// The fixpoint the day has to finish at, or nil for the anchor.
        let end: TripFixpoint?

        var isOrdinary: Bool { start == nil && end == nil }
    }

    static func of(_ day: TripDay) -> Ends {
        let located = day.fixpoints.filter(\.hasPlace)
        guard !located.isEmpty else { return Ends(start: nil, end: nil) }

        // A departure ends the day wherever it is: after the last train
        // you are gone. The earliest wins — a second one the same day is
        // somebody correcting themselves, and the earlier one catches.
        let end = located
            .filter(\.isDeparture)
            .min { $0.startMinutes < $1.startMinutes }

        // The start is whatever finished before the day's first block:
        // the arrival, in practice. Departures are never candidates —
        // they are the far end of the same day.
        let firstBlockStart = day.blocks.compactMap(\.startMinutes).min()
        let start = firstBlockStart.flatMap { begins in
            located
                .filter { !$0.isDeparture && $0.endMinutes <= begins }
                .max { $0.endMinutes < $1.endMinutes }
        }

        return Ends(start: start, end: end)
    }
}

extension TripFixpoint {
    /// True when somebody said where this happens.
    ///
    /// Half a coordinate is none: a latitude without a longitude is not
    /// a place with a gap in it.
    var hasPlace: Bool { lat != nil && lon != nil }

    /// When the fixpoint lets go of the day again.
    var endMinutes: Int { startMinutes + durationMinutes }
}
