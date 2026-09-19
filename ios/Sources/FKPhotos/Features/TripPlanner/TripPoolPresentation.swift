import SwiftUI

/// The two shapes of one pool (§5.2).
///
/// A `String` raw value because the choice is remembered in
/// `@AppStorage`, and a stored preference outlives the order of a
/// Swift enum's cases.
enum TripPoolPresentation: String, CaseIterable, Equatable {
    case list
    case map

    var label: String {
        switch self {
        case .list: return "Liste"
        case .map:  return "Karte"
        }
    }

    var symbolName: String {
        switch self {
        case .list: return "list.bullet"
        case .map:  return "map"
        }
    }
}

/// What the pool shows, for the list and the map alike (§5.2).
///
/// The two are one pool in two shapes, and the search above them is one
/// search: what disappears from the list has to disappear as a pin too,
/// or the map quietly answers a different question than the field the
/// traveller just typed in. Pure, so both can agree by sharing this
/// rather than by both being written carefully.
enum TripPoolFilter {
    /// The pool, best first, narrowed to what somebody typed.
    ///
    /// Name, category and note all count as the thing you remember. The
    /// note especially: "beste Pastéis laut Blog" is often the only part
    /// of a find anybody recalls, and a search that ignored it would
    /// miss exactly the entries a person added by hand (§9.2).
    static func matches(in pool: [TripCandidate], query: String) -> [TripCandidate] {
        let sorted = pool.sorted {
            $0.score != $1.score ? $0.score > $1.score : $0.displayName < $1.displayName
        }
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return sorted }
        return sorted.filter { candidate in
            [candidate.displayName, TripCategory.label(candidate.category), candidate.note ?? ""]
                .contains { $0.lowercased().contains(needle) }
        }
    }

    /// "12 Kandidaten", or "3 von 12" once the search has narrowed it.
    static func countLabel(shown: Int, of total: Int) -> String {
        guard shown != total else {
            return total == 1 ? "1 Kandidat" : "\(total) Kandidaten"
        }
        return "\(shown) von \(total)"
    }

    /// Is this candidate longer than any single block of the day can
    /// hold (§4.7)?
    ///
    /// The planner fills each block inside its budget, so a four-hour
    /// walk in a day of three-and-a-half-hour blocks will never be
    /// chosen — it has to be planned by hand, and then it runs into the
    /// block after it. Only blocks that take spots are asked: a meal
    /// block holds time, not places (§10.3).
    static func needsMoreThanOneBlock(_ candidate: TripCandidate, in leg: TripLeg) -> Bool {
        let holders = leg.days.flatMap(\.blocks).filter { !$0.isMeal }
        guard !holders.isEmpty else { return false }
        return holders.allSatisfy { $0.budgetMinutes < candidate.dwellMinutes }
    }

    /// Which spots of the leg are already on a day.
    static func plannedRefs(of leg: TripLeg) -> Set<String> {
        Set(leg.days.flatMap { $0.blocks }.flatMap { $0.stops }.map(\.osmRef))
    }
}

/// What a pin in the pool is, in one word (§5.2).
///
/// The pins carry no numbers, because the pool has no order. What the
/// colour can say instead is what the list says in words on each row:
/// somebody's own find, a photo stop, one that is already on a day —
/// and otherwise simply a candidate.
///
/// One kind per pin, in that order of precedence: "already planned"
/// beats the rest because it is the answer to the question somebody
/// scanning the map is actually asking — what is still to be had.
enum TripPoolPinKind: String, CaseIterable, Equatable {
    case planned
    case ownFind
    case photoStop
    case candidate

    static func of(_ candidate: TripCandidate, plannedRefs: Set<String>) -> TripPoolPinKind {
        if plannedRefs.contains(candidate.osmRef) { return .planned }
        if candidate.isManual { return .ownFind }
        if candidate.isPhotoStop { return .photoStop }
        return .candidate
    }

    /// What most pins are, first — the same principle the day map's
    /// legend follows.
    static let legendOrder: [TripPoolPinKind] = [.candidate, .ownFind, .photoStop, .planned]

    var label: String {
        switch self {
        case .planned:   return "schon eingeplant"
        case .ownFind:   return "eigener Fund"
        case .photoStop: return "Fotostopp"
        case .candidate: return "Kandidat"
        }
    }

    var colour: Color {
        switch self {
        case .planned:   return .green
        case .ownFind:   return .purple
        case .photoStop: return .orange
        case .candidate: return .accentColor
        }
    }

    /// Drawn inside the dot. The category symbol would be truer to the
    /// place, but a map of a hundred and fifty different glyphs is a map
    /// nobody reads; the symbol says which of the four this is, and the
    /// sheet a tap away says what the place is.
    var symbolName: String {
        switch self {
        case .planned:   return "checkmark"
        case .ownFind:   return "star.fill"
        case .photoStop: return "camera.fill"
        case .candidate: return "mappin"
        }
    }
}
