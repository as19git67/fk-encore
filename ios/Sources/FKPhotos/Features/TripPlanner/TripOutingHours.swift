import Foundation

/// The two hours a day trip may name, and what follows from them (§4.5).
///
/// Pure, and separate from the sheet that shows it, for the reason the
/// rest of the planner keeps its arithmetic out of views: this is the
/// part with an answer that can be right or wrong, and a rule nobody
/// can test is a rule nobody can trust.
enum TripOutingHours {
    /// False only when both hours were given and they run backwards.
    ///
    /// One hour on its own is always fine: "we leave at eight" says
    /// nothing about coming back, and refusing it would make the app
    /// demand a plan the traveller has not made yet.
    static func addUp(depart: Int?, back: Int?) -> Bool {
        guard let out = depart, let home = back else { return true }
        return home > out
    }

    /// "10:12 (+ 1 h 42 Fahrt)" — when the day starts, given the hour
    /// they leave and the drive the server measured.
    ///
    /// Nil when either half is missing, because the alternative is a
    /// number the app made up. The estimate is shown rather than folded
    /// silently into a shorter afternoon: it is the one part still
    /// guessed once a departure is named, and a guess the traveller can
    /// see is a guess they can correct.
    static func arrival(departMinutes: Int?, travelMinutes: Int?) -> String? {
        guard let depart = departMinutes, let travel = travelMinutes, travel > 0 else {
            return nil
        }
        return "\(TripClock.format(depart + travel)) (+ \(TripClock.duration(travel)) Fahrt)"
    }
}
