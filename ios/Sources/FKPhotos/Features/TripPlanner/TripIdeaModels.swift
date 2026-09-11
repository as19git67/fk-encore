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
}
