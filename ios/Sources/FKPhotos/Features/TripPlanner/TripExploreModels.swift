import Foundation

/// What a browse of an area answers with (§9.2, case 4 widened).
///
/// The wire shape of `POST /trip-planner/explore`, and the sentences
/// read off it. Both live here rather than on the view model for the
/// reason two red builds have already made: the view model is
/// `@MainActor`, and anything on it becomes actor-isolated and
/// unreachable from a test.
struct TripExploredSpot: Codable, Identifiable, Sendable {
    let osmRef: String
    let name: String?
    let localName: String?
    let lat: Double
    let lon: Double
    let distanceM: Int
    let category: String
    let dwellMinutes: Int
    let openingHours: String?
    let website: String?
    let wikipediaUrl: String?
    let reasons: [String]
    /// Already in the collection this was marked against — shown rather
    /// than filtered away: "das habt ihr schon" is an answer.
    let collected: Bool

    var id: String { osmRef }

    var displayName: String {
        if let name, !name.isEmpty { return name }
        return "Unbenannter Ort"
    }

    /// Distance, how long one stays, and — where OpenStreetMap knows —
    /// when it is open.
    ///
    /// The opening hours go in verbatim, unparsed. OSM's syntax is a
    /// language of its own and half-understanding it is how a screen
    /// comes to claim a museum is open on a Monday it is not (§15.3);
    /// what is written there is at least what somebody mapped.
    var factsLine: String {
        var parts = [TripDistance.text(distanceM), TripClock.duration(dwellMinutes)]
        if let openingHours, !openingHours.isEmpty { parts.append(openingHours) }
        return parts.joined(separator: " · ")
    }
}

struct TripExploreResponse: Codable, Sendable {
    let region: String?
    /// No imported region covers this coordinate — see `note`.
    let regionMissing: Bool
    let spots: [TripExploredSpot]
    let hasMore: Bool
    /// Why the list is empty, when it is. The server's words, because
    /// which kind of empty this is depends on what it found.
    let note: String?
}

/// Where a browse is centred, and what to call that on screen.
///
/// The interest vocabulary the chips are built from is
/// `TripInterestOption`, which the trip settings screen already
/// declares — fetched from `GET /trip-planner/interests` and never
/// copied into Swift, because a second copy of the list would drift the
/// first time an OSM tag is added to one of them.
///
/// Two ways to get one and they read differently: the phone knows where
/// it is, and a name somebody typed has to be turned into a coordinate
/// by Apple's geocoder first — *a name is not a place*, so nothing is
/// searched until a point has been picked out of the results.
struct TripExploreArea: Equatable, Sendable {
    var label: String
    var lat: Double
    var lon: Double
}

enum TripExploreDefaults {
    /// Wide enough for "die Gegend", narrow enough to mean something.
    /// The same figure the server defaults to, named here so the picker
    /// can show what it is asking for.
    static let radiusM = 5_000
    static let radiusChoices = [2_000, 5_000, 15_000, 30_000]

    /// "5 km im Umkreis" — the radius as the picker says it.
    static func radiusLabel(_ metres: Int) -> String {
        "\(TripDistance.text(metres)) im Umkreis"
    }
}
