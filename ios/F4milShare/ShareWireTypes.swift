import Foundation

/// What the server sends the share extension, as Swift sees it (§9.2).
///
/// Its own file because these types are the one thing in the extension
/// that can be tested: they are pure `Decodable`s over Foundation, with
/// no UIKit, no App Group and no network, so the SwiftPM package can
/// compile them into `F4milShareWire` and decode captured responses
/// through them (`Tests/F4milShareWireTests`). The extension itself
/// stays where it is; this file is simply built twice.
///
/// That matters because of how the mirroring fails. CI compiles the
/// extension — `xcodebuild -target F4milShare`, since #1120 — and a
/// type that names a field the server never sends compiles perfectly
/// well. `ShareIdeaCollection` once asked for a `label`; every decode
/// threw `keyNotFound`, the list came back empty, and the share sheet
/// demanded a trip for months. A compiler cannot see that. A test that
/// decodes what the server actually sends can, and now does.

// MARK: - Models

struct SharePlanSummary: Decodable, Identifiable {
    let id: Int
    let title: String?
    let legTitles: [String?]

    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        let named = legTitles.compactMap { $0 }.filter { !$0.isEmpty }
        return named.isEmpty ? "Reise" : named.joined(separator: " \u{2192} ")
    }
}

/// A collection the share may go into instead of a trip (§20).
///
/// The whole point of the idea pool is that it needs no trip, and until
/// now the share sheet insisted on one: a map link somebody sent could
/// only be saved into a journey that already existed.
///
/// A mirror of the server's `IdeaCollection`, and the mirroring is the
/// part to be careful about: this file cannot import the app's own
/// `TripIdeaCollection`, and nothing compiles the two against each
/// other. This type once declared a `label` the server has never sent,
/// so every decode threw `keyNotFound`, the list came back empty, and
/// the picker offered trips only — the exact symptom the collection was
/// added to remove.
///
/// So the fields are the three the server actually sends, and the label
/// is computed here from them, word for word as the app computes it.
struct ShareIdeaCollection: Decodable, Identifiable {
    let ownerId: Int
    /// Whose it is. Null for one's own — the server names other people,
    /// not the caller.
    let ownerName: String?
    let own: Bool

    var id: Int { ownerId }

    var label: String {
        if own { return "Mein Vorrat" }
        guard let ownerName, !ownerName.isEmpty else { return "Geteilter Vorrat" }
        return "Vorrat von \(ownerName)"
    }
}

/// What the server made of a shared link.
///
/// Three answers, and the caller has to tell them apart: a place, a
/// page that is not a map link at all, and a short link nobody could
/// follow — only the last is worth trying again.
struct ShareMapLinkRead: Decodable, Sendable {
    let isMapLink: Bool
    let lat: Double?
    let lon: Double?
    let name: String?
    let unresolved: Bool
}

struct ShareProposal: Decodable, Identifiable, Sendable {
    let name: String?
    let verdict: String
    let position: Coordinate?
    let osmRef: String?
    let categories: [String]
    let legIndex: Int?
    let options: [Option]
    let quote: String?
    let placeHint: String?

    struct Coordinate: Decodable, Sendable {
        let lat: Double
        let lon: Double
    }

    struct Option: Decodable, Identifiable, Hashable, Sendable {
        let osmRef: String
        let name: String?
        let lat: Double
        let lon: Double
        let legIndex: Int
        let distanceM: Double?
        var id: String { osmRef }
    }

    var id: String { "\(verdict)|\(osmRef ?? "")|\(name ?? "")|\(quote ?? "")" }

    var canAdd: Bool { position != nil || osmRef != nil }

    var needsDuration: Bool {
        verdict == "coordinate" || (verdict == "none" && position != nil)
    }

    var needsChoice: Bool { verdict == "ambiguous" }
}

struct ShareAnalyzeResponse: Decodable, Sendable {
    let kind: String
    let sourceUrl: String?
    let proposals: [ShareProposal]
    let rejected: [String]
}
