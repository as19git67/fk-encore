import Foundation

/// Turning geofence crossings into a stay (§6.4, signal 1).
///
/// The concept is emphatic that **the dwell is what counts, not the
/// entry**: walking past a museum is not a visit. So a crossing on its
/// own reports nothing; what reports is a stay that ended, with a
/// duration attached.
///
/// Three things this has to survive, all of them ordinary rather than
/// exotic, and all of them silent when got wrong:
///
///   - **A repeated enter with no exit between them.** iOS re-delivers
///     region events, and on a launch after a cold start it may report
///     the region you are already inside. Counting the second entry as
///     a fresh arrival would reset the clock just as the dwell was
///     about to qualify.
///   - **An exit with no entry.** The same cold start, from the other
///     side: the app wakes up outside a region it never saw you enter.
///     There is no stay to report, and inventing one from "now minus
///     something" would be a fabricated timestamp.
///   - **A stay still running.** The traveller may open the app while
///     standing in the museum. What is known then is an arrival and no
///     departure, and the honest answer is "still here", not a stay of
///     zero minutes.
///
/// Pure and time-injected: the whole of it is testable without walking
/// anywhere, which is the only practical way to test it at all.
struct TripDwellTracker {
    /// Arrivals seen and not yet closed, keyed by the region's id.
    private(set) var openStays: [String: Date] = [:]

    init(openStays: [String: Date] = [:]) {
        self.openStays = openStays
    }

    /// Someone crossed into the fence.
    ///
    /// A second entry for a region already open is ignored rather than
    /// treated as a new arrival — see the note above about the clock
    /// being reset just before it qualifies.
    mutating func entered(_ regionId: String, at time: Date) {
        guard openStays[regionId] == nil else { return }
        openStays[regionId] = time
    }

    /// Someone crossed back out. Answers the stay, or nil when there
    /// was no arrival to close.
    mutating func exited(_ regionId: String, at time: Date) -> TripStay? {
        guard let arrivedAt = openStays.removeValue(forKey: regionId) else { return nil }
        // A clock that went backwards — a manual time change, or events
        // delivered out of order — would otherwise produce a negative
        // stay, which every threshold below would read as "brief".
        guard time > arrivedAt else { return nil }
        return TripStay(regionId: regionId, arrivedAt: arrivedAt, departedAt: time)
    }

    /// How long the stay in this region has been running, or nil if
    /// there is none. For "you have been here 40 minutes" while it is
    /// still happening.
    func openMinutes(_ regionId: String, now: Date) -> Int? {
        guard let arrivedAt = openStays[regionId], now > arrivedAt else { return nil }
        return Int(now.timeIntervalSince(arrivedAt) / 60)
    }

    /// Close every open stay, for when monitoring stops — the day ends,
    /// the trip ends, or the plan changed under it.
    ///
    /// Reported rather than dropped: a museum you are still standing in
    /// when the day rolls over is a visit that happened.
    mutating func closeAll(at time: Date) -> [TripStay] {
        let stays = openStays.compactMap { regionId, arrivedAt -> TripStay? in
            guard time > arrivedAt else { return nil }
            return TripStay(regionId: regionId, arrivedAt: arrivedAt, departedAt: time)
        }
        openStays.removeAll()
        // A stable order, so two runs over the same state report the
        // same thing in the same sequence.
        return stays.sorted { $0.arrivedAt < $1.arrivedAt }
    }
}

/// One completed stay inside a fence.
struct TripStay: Equatable, Sendable {
    let regionId: String
    let arrivedAt: Date
    let departedAt: Date

    var minutes: Int { Int(departedAt.timeIntervalSince(arrivedAt) / 60) }
}

/// Does this stay count, and does it count on its own?
///
/// The threshold mirrors `trip-planner/visits.ts` deliberately: the app
/// uses it to decide whether reporting is worth a network call at all,
/// and the **server recomputes the verdict** rather than believing the
/// device. The rule is a product decision, and one that lives in two
/// places drifts — so the device's copy is an optimisation, never the
/// authority.
enum TripDwellRule {
    /// Never below this, whatever the plan allowed. Ten minutes at a
    /// viewpoint is a visit; two is a photo stop.
    static let minimumMinutes = 10
    /// A quarter of the planned stay, for places where the plan allowed
    /// a lot: twenty minutes of a ninety-minute museum is not a visit.
    static let fraction = 0.25

    static func thresholdMinutes(plannedMinutes: Int) -> Int {
        max(minimumMinutes, Int((Double(plannedMinutes) * fraction).rounded()))
    }

    /// Worth telling the server about?
    static func isWorthReporting(_ stay: TripStay, plannedMinutes: Int) -> Bool {
        stay.minutes >= thresholdMinutes(plannedMinutes: plannedMinutes)
    }
}
