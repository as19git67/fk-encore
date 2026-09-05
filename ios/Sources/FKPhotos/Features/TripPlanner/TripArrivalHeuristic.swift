import Foundation

/// Noticing that what is left of a block will not fit in what is left
/// of its time — and **offering** a redistribution (§7.1).
///
/// Offered, never performed: "ungefragt umzuräumen wäre übergriffig".
/// That sentence is the whole design of this file, which is why
/// everything here answers a question rather than doing something.
///
/// The test is deliberately the direct one — remaining work against
/// remaining time — rather than a progress fraction. "Two of four done
/// with half the block gone" sounds like the right thing to measure and
/// is not: two long stops and two short ones make it meaningless, and a
/// block with one stop left and two hours to do it in is not behind. The
/// app already knows what each remaining stop costs, so it can ask the
/// question that actually matters.
///
/// Two guards keep it from becoming a nag, because a nagged traveller
/// switches the feature off — and then the case it exists for, the
/// evening about to be lost, never fires either:
///
///   - not before the block is half gone, which is when the concept
///     says the situation becomes legible;
///   - once per block, whatever happens afterwards.
///
/// Pure. Minutes and counts in, a verdict out — no clock, no location,
/// no timers. The device supplies the facts; this only weighs them.
enum TripArrivalHeuristic {

    /// How much of the block has to be gone before being behind counts.
    /// Early on, estimates are least reliable and the group may simply
    /// be walking fast.
    static let minimumElapsedFraction = 0.5

    /// An overrun smaller than this is noise: a few minutes either way
    /// is inside what a straight-line walking estimate can tell.
    static let toleranceMinutes = 10

    /// Below this there is no room to redistribute into, so asking only
    /// costs the traveller a decision.
    static let minimumRemainingMinutes = 15

    struct Situation {
        /// Minutes of the current block already spent.
        let elapsedMinutes: Int
        /// Minutes of it left.
        let remainingMinutes: Int
        /// Dwell plus travel still to come in this block — what the
        /// stops that are neither done nor skipped will cost.
        let remainingWorkMinutes: Int
        /// How many stops that is.
        let remainingStops: Int
        /// Whether a suggestion for this block has already been made.
        let alreadySuggested: Bool
    }

    enum Verdict: Equatable {
        /// Say nothing.
        case quiet
        /// Offer a redistribution, with the sentence to show.
        case offer(reason: String)
    }

    static func evaluate(_ s: Situation) -> Verdict {
        // Asked once per block. A second prompt for the same block is a
        // nag, and a traveller who wants it can press the button.
        if s.alreadySuggested { return .quiet }
        // Nothing left to be behind on.
        if s.remainingStops <= 0 { return .quiet }
        // No room to move anything into.
        if s.remainingMinutes < minimumRemainingMinutes { return .quiet }

        let total = s.elapsedMinutes + s.remainingMinutes
        guard total > 0 else { return .quiet }
        if Double(s.elapsedMinutes) / Double(total) < minimumElapsedFraction { return .quiet }

        let overrun = s.remainingWorkMinutes - s.remainingMinutes
        if overrun < toleranceMinutes { return .quiet }

        return .offer(reason: s.remainingStops == 1
            ? "Der letzte Stopp braucht noch etwa \(s.remainingWorkMinutes) Minuten, "
                + "der Block hat noch \(s.remainingMinutes). Umplanen?"
            : "Die \(s.remainingStops) offenen Stopps brauchen noch etwa "
                + "\(s.remainingWorkMinutes) Minuten, der Block hat noch "
                + "\(s.remainingMinutes). Umplanen?")
    }
}
