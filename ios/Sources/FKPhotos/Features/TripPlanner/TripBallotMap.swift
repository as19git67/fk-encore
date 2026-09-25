import SwiftUI

/// The ballot on a map (§6.1, §5.2).
///
/// Out of the first trial: the list says what and where in words, and
/// the map says the same thing at a glance — three of the "will ich"
/// are in the same lane, the one "lieber nicht" is the only thing on
/// the far shore. The map is the pool's map with the vote as its
/// colour, and a tap opens the same row the list shows: the three
/// answers, the heart, and the details behind an info button.
///
/// Pure where it decides anything, so the colours can be tested
/// without a map.
enum TripBallotPinKind: String, CaseIterable, Equatable {
    case heart
    case want
    case meh
    case ratherNot
    /// No answer from me yet — the pins the ballot is still waiting on.
    case open

    static func of(_ entry: TripBallotEntry) -> TripBallotPinKind {
        if entry.myHeart { return .heart }
        switch entry.myVote.flatMap(TripVote.init(rawValue:)) {
        case .want: return .want
        case .meh: return .meh
        case .ratherNot: return .ratherNot
        case nil: return .open
        }
    }

    /// What most pins are first: the open ones, which are the reason
    /// to look at the map at all.
    static let legendOrder: [TripBallotPinKind] = [.open, .want, .heart, .meh, .ratherNot]

    var label: String {
        switch self {
        case .heart: return "Herzenswunsch"
        case .want: return "will ich"
        case .meh: return "egal"
        case .ratherNot: return "lieber nicht"
        case .open: return "noch offen"
        }
    }

    var colour: Color {
        switch self {
        case .heart: return .pink
        case .want: return .green
        case .meh: return .gray
        case .ratherNot: return .red
        case .open: return .blue
        }
    }

    var symbolName: String {
        switch self {
        case .heart: return "heart.fill"
        case .want: return "hand.thumbsup.fill"
        case .meh: return "minus"
        case .ratherNot: return "hand.thumbsdown.fill"
        case .open: return "questionmark"
        }
    }
}

enum TripBallotMap {
    /// A pin per entry the leg still knows a place for. An entry the leg
    /// has lost between two loads has no coordinate and no pin — the
    /// list shows it with an empty line for the same reason.
    static func pins(for entries: [TripBallotEntry], in leg: TripLeg) -> [TripSpotMapPin] {
        entries.compactMap { entry in
            guard let spot = TripBallotDetails.of(entry.osmRef, in: leg).spot else { return nil }
            let kind = TripBallotPinKind.of(entry)
            return TripSpotMapPin(
                id: entry.osmRef,
                coordinate: spot.coordinate,
                title: entry.label,
                symbolName: kind.symbolName,
                tint: kind.colour,
            )
        }
    }
}
