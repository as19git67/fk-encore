import Foundation

/// „Ihr habt vier Ideen für Lissabon gesammelt." (§20.3)
///
/// The sentence the concept wrote and the app never said: a trip is
/// created, and the ideas collected for that city sit two menus away
/// with nothing to say they exist. This is the one line on the day
/// screen that says so — an offer, never a handover. Nothing is taken
/// over by itself; the line leads to the screen where somebody decides.
enum TripIdeasOffer {
    /// The sentence for what is not yet in the trip, or nil when there
    /// is nothing to offer.
    ///
    /// - Parameter pending: ideas that lie in a leg and are not already
    ///   in the trip.
    /// - Parameter legTitle: the city's name for a leg index.
    static func sentence(pending: [TripIdeaForPlan], legTitle: (Int) -> String) -> String? {
        guard !pending.isEmpty else { return nil }
        let cities = Array(Set(pending.map(\.legIndex))).sorted().map(legTitle)
        let what = pending.count == 1 ? "eine Idee" : "\(numberWord(pending.count)) Ideen"
        return "Ihr habt \(what) für \(joined(cities)) gesammelt."
    }

    /// "Lissabon", "Lissabon und Porto", "Lissabon, Porto und Faro".
    static func joined(_ names: [String]) -> String {
        switch names.count {
        case 0: return ""
        case 1: return names[0]
        default: return names.dropLast().joined(separator: ", ") + " und " + names[names.count - 1]
        }
    }

    /// Small counts in words, the way the sentence was written; digits
    /// beyond what anybody says out loud.
    static func numberWord(_ n: Int) -> String {
        let words = ["null", "eine", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht",
                     "neun", "zehn", "elf", "zwölf"]
        return n >= 0 && n < words.count ? words[n] : String(n)
    }
}

/// Which offer somebody has already waved away, per trip.
///
/// Stored as the count that was dismissed rather than as a flag: "Später"
/// on four ideas should not silence a fifth collected next week. The
/// same count again is the same offer, and stays quiet.
struct TripIdeasOfferMemory {
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    private func key(_ planId: Int) -> String { "trip.ideasOffer.dismissedCount.\(planId)" }

    /// Should the offer for this many pending ideas be shown?
    func shouldOffer(planId: Int, pendingCount: Int) -> Bool {
        guard pendingCount > 0 else { return false }
        return defaults.integer(forKey: key(planId)) != pendingCount
    }

    func dismiss(planId: Int, pendingCount: Int) {
        defaults.set(pendingCount, forKey: key(planId))
    }

    func forget(planId: Int) {
        defaults.removeObject(forKey: key(planId))
    }
}
