import Foundation

/// The collection without a trip (§20), as the app sees it.
///
/// Everything else in the planner needs a trip. This is the half people
/// *collect* — the beer garden somebody mentioned, the exhibition in the
/// next town. The server has carried it since migration 0179 and no
/// screen ever showed it; these are the shapes that screen needs.

struct TripIdea: Codable, Identifiable, Sendable {
    let id: Int
    let osmRef: String
    /// What the map calls it. Null for a place OpenStreetMap does not know.
    let name: String?
    /// What the family calls it, when that is not the map's name.
    let title: String?
    let lat: Double
    let lon: Double
    let category: String
    let dwellMinutes: Int
    let note: String?
    let sourceUrl: String?
    /// True when no OSM entry matched — category and duration are guesses,
    /// and the screen says so rather than presenting them as data (§15.3).
    let unmatched: Bool
    let validFrom: String?
    let validTo: String?
    /// Who put it there. "Der Biergarten, den Anna gemerkt hat" is half
    /// the information (§20.1).
    let addedBy: String?
    let addedAt: String

    /// The name to show — what the family calls it wins over the map.
    var displayName: String {
        if let title, !title.isEmpty { return title }
        if let name, !name.isEmpty { return name }
        return "Unbenannter Ort"
    }

    /// The one line under the name, or nil when there is nothing to say.
    ///
    /// Deliberately not assembled from everything known: a row that
    /// always carries three facts is a row nobody reads. The note is what
    /// a person wrote, and it beats anything derived.
    var subtitle: String? {
        if let note, !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return note
        }
        if let addedBy, !addedBy.isEmpty { return "von \(addedBy)" }
        return nil
    }
}

/// A collection the signed-in person may write into (§20.1).
struct TripIdeaCollection: Codable, Identifiable, Sendable {
    let ownerId: Int
    let ownerName: String?
    /// True for the caller's own collection.
    let own: Bool

    var id: Int { ownerId }
    var label: String {
        if own { return "Mein Vorrat" }
        guard let ownerName, !ownerName.isEmpty else { return "Geteilter Vorrat" }
        return "Vorrat von \(ownerName)"
    }
}

struct TripIdeasResponse: Codable, Sendable {
    let entries: [TripIdea]
    let collections: [TripIdeaCollection]
}

struct TripIdeaAddResponse: Codable, Sendable {
    let entry: TripIdea
    /// True when this folded into an idea that was already collected.
    let merged: Bool
    let matchedOsmRef: String?
    /// What is not known about it, in plain words (§15.3).
    let unknown: [String]

    /// What to say afterwards.
    ///
    /// On the response rather than in the view model, for the same
    /// reason `displayName` sits on the entry: it is a reading of what
    /// came back, with no state and no clock behind it — and a pure
    /// function has no business being bound to an actor.
    ///
    /// Two things it refuses to smooth over. A **merge** means the list
    /// will not grow, which somebody who just tapped "merken" would
    /// otherwise read as a failure. And what the map could **not** tell
    /// us is named rather than passed off as data (§15.3).
    var sentence: String {
        var parts: [String] = [
            merged
                ? "\(entry.displayName) war schon im Vorrat — ergänzt."
                : "\(entry.displayName) ist im Vorrat.",
        ]
        if !unknown.isEmpty {
            parts.append("Unbekannt: \(unknown.joined(separator: ", ")).")
        }
        return parts.joined(separator: " ")
    }
}

/// An idea near where you are standing (§20.2).
///
/// Its own shape rather than `TripIdea` with a distance bolted on: the
/// nearby answer is a different question with a different set of
/// fields, and the distance is the whole point of it.
struct TripNearIdea: Codable, Identifiable, Sendable {
    let id: Int
    let osmRef: String
    let name: String?
    let lat: Double
    let lon: Double
    let distanceM: Int
    let category: String
    let dwellMinutes: Int
    let note: String?
    /// Who put it there — "der Biergarten, den Anna gemerkt hat" (§20.1).
    let addedBy: String?
    let validTo: String?

    var displayName: String {
        if let name, !name.isEmpty { return name }
        return "Unbenannter Ort"
    }

    /// How far, in words somebody standing there would use.
    ///
    /// Metres below a kilometre and one decimal above it: "1.4 km" is a
    /// walk you can picture, "1437 m" is a number you have to convert.
    var distanceText: String {
        if distanceM < 1000 { return "\(distanceM) m" }
        let km = Double(distanceM) / 1000
        return String(format: "%.1f km", km).replacingOccurrences(of: ".", with: ",")
    }

    /// The line under the name: who collected it, and the note if there is one.
    var subtitle: String? {
        let note = note?.trimmingCharacters(in: .whitespacesAndNewlines)
        switch (note?.isEmpty == false ? note : nil, addedBy) {
        case let (note?, by?): return "\(note) — von \(by)"
        case let (note?, nil): return note
        case let (nil, by?): return "von \(by)"
        default: return nil
        }
    }
}

struct TripIdeaNearbyResponse: Codable, Sendable {
    let ideas: [TripNearIdea]
    /// Ideas in range that were deliberately not offered: told recently,
    /// or waved away often enough. Counted rather than listed — the
    /// number is honest, the list would be noise (§20.2).
    let quiet: Int
}

/// One stop of a proposed outing (§20.2).
struct TripOutingStop: Codable, Identifiable, Sendable {
    let osmRef: String
    let name: String?
    let lat: Double
    let lon: Double
    let category: String
    let dwellMinutes: Int
    /// Minutes of travel from the previous stop — from the anchor, for the first.
    let travelMinutes: Int
    /// True for something the family collected, false for a fresh find.
    let fromIdeas: Bool
    let addedBy: String?

    var id: String { osmRef }
    var displayName: String {
        if let name, !name.isEmpty { return name }
        return "Unbenannter Ort"
    }
}

/// „Soll ich daraus einen Nachmittag machen?" (§20.2)
struct TripOutingProposal: Codable, Sendable {
    /// True when there is anything worth proposing at all.
    let offered: Bool
    /// Why not, when not: ok | no-ideas | nothing-fits.
    let reason: String
    let stops: [TripOutingStop]
    /// Minutes the proposal actually uses, travel included.
    let usedMinutes: Int
    let budgetMinutes: Int
    /// Ideas considered but left out — the honest "was fällt weg".
    let leftOut: Int

    /// What to say when there is no proposal.
    ///
    /// The two refusals mean different things and a shared sentence
    /// would hide which: nothing collected nearby is a full collection
    /// somewhere else, nothing fitting is a budget too small for what
    /// is here.
    var refusal: String? {
        guard !offered else { return nil }
        switch reason {
        case "no-ideas":
            return "In der Nähe liegt nichts aus eurem Vorrat — und die Umgebung gibt auch nichts her."
        case "nothing-fits":
            return "Was hier liegt, passt nicht in die Zeit. Mit mehr Zeit sieht das anders aus."
        default:
            return "Daraus lässt sich gerade kein Ausflug machen."
        }
    }

    /// "2 h 15" rather than "135 Minuten" — an afternoon is hours.
    static func duration(_ minutes: Int) -> String {
        let hours = minutes / 60
        let rest = minutes % 60
        if hours == 0 { return "\(rest) Min." }
        if rest == 0 { return "\(hours) h" }
        return "\(hours) h \(rest)"
    }

    /// The line under the proposal: what it uses, and what falls away.
    var summary: String {
        var sentence = "\(Self.duration(usedMinutes)) von \(Self.duration(budgetMinutes))"
        if leftOut == 1 {
            sentence += " · eine Idee bleibt liegen"
        } else if leftOut > 1 {
            sentence += " · \(leftOut) Ideen bleiben liegen"
        }
        return sentence
    }
}

/// What accepting an outing produced (§20.3).
///
/// Only the id of the trip is read here: what the day looks like is the
/// planner's screen to show, and decoding the whole plan twice would be
/// two places to keep in step with the server.
struct TripOutingAcceptResponse: Codable, Sendable {
    struct PlanRef: Codable, Sendable { let id: Int }
    let plan: PlanRef
    /// Ideas that ended up on the day.
    let planned: [Int]
    /// Accepted but not on the day — they are in the trip\'s pool. Said
    /// rather than silently dropped: the outing that fits is shorter
    /// than the one somebody wanted (§5).
    let inPool: [Int]
}
