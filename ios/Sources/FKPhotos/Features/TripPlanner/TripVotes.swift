import SwiftUI

// The vote over a stay's spots (§6.1): everybody rates, nobody is
// averaged away. Since the candidate ranking's stage 5 there is no
// screen of its own for it — every row of the candidate list carries
// the vote as a ring, and the sections about the stay as a whole
// (fairness, who has not said anything, "Damit neu planen") stand at
// the head of that list (`TripPoolView`).

enum TripVote: String, CaseIterable, Sendable {
    case want
    case meh
    case ratherNot = "rather-not"

    var label: String {
        switch self {
        case .want: return "Will ich"
        case .meh: return "Egal"
        case .ratherNot: return "Lieber nicht"
        }
    }

    var symbolName: String {
        switch self {
        case .want: return "hand.thumbsup"
        case .meh: return "minus.circle"
        case .ratherNot: return "hand.thumbsdown"
        }
    }
}

struct TripBallot: Codable, Sendable {
    let legIndex: Int
    let entries: [TripBallotEntry]
    /// Settings left for me on this leg (§6.1).
    let heartsLeft: Int
    let heartQuota: Int
    /// Who has not said anything at all yet.
    let silent: [String]
}

struct TripBallotEntry: Codable, Identifiable, Sendable {
    var id: String { osmRef }
    let osmRef: String
    let name: String?
    /// What to put on the row — the name where the map has one, else
    /// what it does know ("Kirche (ohne Namen)"). Never the reference:
    /// nobody can vote on `way:213850482`.
    let label: String
    let category: String
    let myVote: String?
    let myHeart: Bool
    let wants: [String]
    let ratherNots: [String]
    let hearts: [String]
    let planned: Bool

    /// Who said what, in names rather than a number: an average is what
    /// this whole chapter exists to avoid (§6.1).
    var voices: String? {
        var parts: [String] = []
        if !hearts.isEmpty { parts.append("Herzenswunsch: \(hearts.joined(separator: ", "))") }
        if !wants.isEmpty { parts.append("will: \(wants.joined(separator: ", "))") }
        if !ratherNots.isEmpty {
            parts.append("lieber nicht: \(ratherNots.joined(separator: ", "))")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

struct TripFairness: Codable, Sendable {
    let rows: [TripFairnessRow]
    /// The account in one sentence, or nil when there is nothing to say.
    let sentence: String?
}

struct TripFairnessRow: Codable, Identifiable, Sendable {
    var id: String { voter }
    let voter: String
    let name: String
    let granted: Int
    let deferred: Int
}

struct TripCastVoteRequest: Encodable, Sendable {
    /// Which leg the spot belongs to. Left out, the server assumed the
    /// first one — so on a trip with several cities a vote cast in
    /// Osaka was recorded against Tokyo.
    let legIndex: Int
    let osmRef: String
    let value: String
    let heart: Bool
}

struct TripCastVoteResponse: Codable, Sendable {
    let osmRef: String
    let value: String
    let heart: Bool
    let heartsLeft: Int
}

struct TripEmptyBody: Encodable, Sendable {}
