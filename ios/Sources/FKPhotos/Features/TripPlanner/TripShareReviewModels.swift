import Foundation

/// The wire shapes of `POST /trip-planner/plans/:planId/shares`, plus
/// the one decision the review screen makes on its own.
///
/// That decision is **what a proposal still needs from you** before it
/// can go into the pool, and it is worth naming because the three
/// answers look alike on screen and are not alike at all:
///
///   - a resolved place needs nothing but a yes;
///   - an ambiguous name needs you to pick which one;
///   - a place OpenStreetMap does not have needs a duration, because
///     nothing else can supply one and the planner will not invent it
///     (§9.2, §15.3).
struct TripShareProposal: Codable, Identifiable, Sendable {
    let name: String?
    let verdict: String
    let position: Coordinate?
    let osmRef: String?
    let categories: [String]
    let legIndex: Int?
    let options: [Option]
    let quote: String?
    let placeHint: String?
    let kindHint: String?

    struct Coordinate: Codable, Hashable, Sendable {
        let lat: Double
        let lon: Double
    }

    struct Option: Codable, Identifiable, Hashable, Sendable {
        let osmRef: String
        let name: String?
        let lat: Double
        let lon: Double
        let categories: [String]
        let legIndex: Int
        let distanceM: Double?

        var id: String { osmRef }
    }

    /// Stable within one response, which is all a list needs.
    var id: String { "\(verdict)|\(osmRef ?? "")|\(name ?? "")|\(quote ?? "")" }

    enum Verdict: String {
        /// A map link carried a position; nothing to resolve.
        case coordinate
        /// One place, with its OSM data.
        case unique
        /// Several places of that name — pick one.
        case ambiguous
        /// None. A note, until somebody resolves it by hand.
        case none
    }

    var kind: Verdict { Verdict(rawValue: verdict) ?? .none }

    /// What the screen has to ask for before this can be added.
    enum Missing: Equatable {
        case nothing
        case whichPlace
        /// No OSM entry behind it: no opening hours, no category, and
        /// no duration anyone could look up.
        case howLong
    }

    var missing: Missing {
        switch kind {
        case .unique: return .nothing
        case .ambiguous: return .whichPlace
        // A map pin has a coordinate but no OSM entry behind it, so it
        // is in exactly the same position as an unresolved name: the one
        // question §9.2 allows the planner to ask.
        case .coordinate, .none: return .howLong
        }
    }

    /// Whether it can be added at all. A name that resolved to nothing
    /// *and* has no position is a note, not a candidate — there is
    /// nowhere to put it on a map.
    var isAddable: Bool {
        position != nil || osmRef != nil || kind == .ambiguous
    }
}

struct TripAnalyseShareResponse: Codable, Sendable {
    let kind: String
    let sourceUrl: String?
    let proposals: [TripShareProposal]
    /// What the server refused, in plain words. Shown, never swallowed.
    let rejected: [String]
}

/// The body of `POST /trip-planner/plans/:planId/finds`, which is where
/// a confirmed proposal actually lands. The five rules of §9.2 live
/// there, not here.
struct TripAddFindRequest: Encodable, Sendable {
    let lat: Double
    let lon: Double
    let name: String?
    let note: String?
    let sourceUrl: String?
    let legIndex: Int?
    let dwellMinutes: Int?
}

struct TripAddFindResponse: Decodable, Sendable {
    let legIndex: Int
    let merged: Bool
    let unknown: [String]
}
