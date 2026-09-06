import Foundation

/// The plan as `trip-planner` returns it. Field names mirror the JSON
/// exactly, so a change on the server surfaces as a decode failure in
/// the tests rather than as a screen that quietly shows nothing.
///
/// The shape is the concept's (docs/ios-urlaubsplanung.md): a trip is a
/// list of **legs** (§4.2), each with its own anchor and pool; a leg has
/// **days**; a day has **blocks**, and a block has **stops**. A day also
/// carries the hard times that frame it (§4.4) and a flag saying whether
/// it has been planned down to spots yet (§4.3).

struct TripPlan: Codable, Identifiable, Sendable {
    let id: Int
    let ownerId: Int
    let title: String?
    /// How the trip is planned — pace, group, interests. Changeable
    /// after the fact through `PATCH …/settings`; decoded leniently
    /// because it is a free-form object on the server and an older plan
    /// may carry fields this build has not learned about.
    let constraints: TripConstraints?
    let legs: [TripLeg]

    enum CodingKeys: String, CodingKey {
        case id, ownerId, title, constraints, legs
    }
}

/// The settings a trip was planned with.
struct TripConstraints: Codable, Sendable {
    var pace: String?
    var categories: [String]?
    var interests: [String]?
    var maxWalkMinutes: Int?
    var group: Group?

    struct Group: Codable, Sendable {
        var withChildren: Bool?
        var limitedMobility: Bool?
    }
}

struct TripLeg: Codable, Identifiable, Sendable {
    let id: Int
    let position: Int
    let title: String?
    let anchor: TripCoordinate
    /// Set when the anchor is a zone rather than an address (§4.2): the
    /// planner reckons with the centroid and this says how far the real
    /// base may sit from it. The UI must not show a zone as a pin.
    let anchorRadiusM: Int?
    let mode: String
    let regionDb: String
    /// True while this leg has its frame and no spots because its
    /// OpenStreetMap region is still being imported (§4.3). Optional so
    /// a response from an older server still decodes.
    let awaitingRegion: Bool?
    /// "YYYY-MM-DD", or nil when the trip has no dates yet.
    let startDate: String?
    let days: [TripDay]
    /// Scored candidates not placed in any day — the working set the
    /// whole replanning mechanic turns on (§5), and at trip resolution
    /// the actual planning result (§4.3).
    let pool: [TripCandidate]

    var transportMode: TripTransportMode { TripTransportMode(raw: mode) }

    /// Is this leg waiting for its maps? Absent means no — an older
    /// server that never had the flag never had a waiting leg either.
    var isAwaitingRegion: Bool { awaitingRegion == true }

    /// What to call this city. Never invents a name for a leg nobody
    /// named (§15.3) — it says which one it is instead.
    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        return "Etappe \(position + 1)"
    }
}

struct TripDay: Codable, Identifiable, Sendable {
    let id: Int
    let dayIndex: Int
    /// False while the day is still only at trip resolution: it has its
    /// frame but no stops yet (§4.3).
    let detailed: Bool
    let blocks: [TripBlock]
    let fixpoints: [TripFixpoint]
}

struct TripBlock: Codable, Identifiable, Sendable {
    /// The template id ("morning"), unique within a day — a block is a
    /// label plus a budget, not a fixed enumeration (§4.1).
    let id: String
    let rowId: Int
    let label: String
    let kind: String
    let budgetMinutes: Int
    /// Travel plus dwell actually used. Never exceeds the budget.
    let usedMinutes: Int
    /// Where the block sits on the day's notional clock, in minutes past
    /// midnight (§8.3). Null for plans written before the frame time was
    /// kept — the slider then has nothing to show for that day, which is
    /// more honest than a guessed hour.
    let startMinutes: Int?
    let stops: [TripStop]

    /// A meal block holds time and a rough area, not a venue (§10.3).
    var isMeal: Bool { kind == "meal" }

    /// When the block ends, if it has an hour at all.
    var endMinutes: Int? { startMinutes.map { $0 + budgetMinutes } }

    /// "ca. 3 h von 3,5 h" — the utilisation line under a block (§8.3).
    var utilisation: Double {
        budgetMinutes > 0 ? Double(usedMinutes) / Double(budgetMinutes) : 0
    }
}

/// The nine categories the region search knows, in words.
///
/// Needed because a pool full of rows reading "Unbenannter Ort" is
/// unusable: OpenStreetMap has no name for a great many viewpoints and
/// not a few attractions, and after the prominence rule those are
/// exactly the unnamed things that still deserve a place in a day. The
/// name is genuinely missing and is never invented (§15.3) — but "ein
/// Aussichtspunkt" is what the data actually says, and it is the
/// difference between a list you can read and eleven identical lines.
enum TripCategory {
    private static let labels: [String: String] = [
        "sight": "Sehenswürdigkeit",
        "museum": "Museum",
        "viewpoint": "Aussichtspunkt",
        "worship": "Kirche oder Tempel",
        "theatre": "Theater oder Kino",
        "food": "Essen",
        "cafe": "Café",
        "essentials": "Alltägliches",
        "outdoors": "Park oder Natur",
    ]

    static func label(_ id: String) -> String {
        labels[id] ?? id
    }

    /// What to call a place OpenStreetMap left unnamed.
    ///
    /// Says which of the two it is — "ein Aussichtspunkt" reads as a
    /// description, "Aussichtspunkt" as a name — so nobody mistakes it
    /// for something the data provided.
    static func unnamed(_ id: String) -> String {
        labels[id].map { "\($0), ohne Namen" } ?? "Unbenannter Ort"
    }

    static let symbols: [String: String] = [
        "sight": "building.columns",
        "museum": "building.columns",
        "viewpoint": "binoculars",
        "worship": "building.2",
        "theatre": "theatermasks",
        "food": "fork.knife",
        "cafe": "cup.and.saucer",
        "essentials": "cart",
        "outdoors": "tree",
    ]

    static func symbol(_ id: String) -> String {
        symbols[id] ?? "mappin"
    }
}

struct TripStop: Codable, Identifiable, Sendable {
    let rowId: Int
    let osmRef: String
    let name: String?
    let lat: Double
    let lon: Double
    let category: String
    let dwellMinutes: Int
    let travelFromPrevious: TripTravel
    /// planned | done | skipped — anything but `planned` is past and is
    /// never moved by a redistribution (§5).
    let status: String
    /// Pinned stops are fixed points: kept where they are (§8.4).
    let pinned: Bool
    /// Why it was saved and where from, carried over from the pool
    /// entry when a find was planned (§9.2). Optional so a response
    /// from an older server still decodes.
    let note: String?
    let sourceUrl: String?

    var id: Int { rowId }
    var stopStatus: TripStopStatus { TripStopStatus(raw: status) }
    var coordinate: TripCoordinate { TripCoordinate(lat: lat, lon: lon) }
    /// What to show when OpenStreetMap has no name for the place. Never
    /// invented — an unnamed spot says so (§15.3), in the words of what
    /// it is rather than as eleven identical lines.
    var displayName: String { name ?? TripCategory.unnamed(category) }
}

struct TripTravel: Codable, Sendable {
    let minutes: Int
    let distanceM: Int
    let travelClass: String

    var symbolName: String {
        switch travelClass {
        case "short_walk", "long_walk": return "figure.walk"
        default: return "tram"
        }
    }
}

struct TripFixpoint: Codable, Identifiable, Sendable {
    let rowId: Int
    let kind: String
    let label: String
    /// Minutes past midnight, local to the leg. 18:40 is 1120.
    let startMinutes: Int
    let durationMinutes: Int
    let travelMinutes: Int
    let bufferMinutes: Int
    let lat: Double?
    let lon: Double?

    var id: Int { rowId }
    /// After an appointment the day goes on; after a departure it is
    /// over (§4.4).
    var isDeparture: Bool { kind == "departure" }
    var startsAt: String { TripClock.format(startMinutes) }
}

struct TripCandidate: Codable, Identifiable, Sendable {
    let osmRef: String
    let name: String?
    let lat: Double
    let lon: Double
    let category: String
    let dwellMinutes: Int
    let score: Double
    /// Why this scored as it did, in plain language — the "Warum hier?"
    /// the concept insists on (§3.8, §8.3).
    let reasons: [String]
    /// search | manual — found by the planner, or brought in by a person
    /// (§9.2). Optional so a response from an older server still decodes.
    let origin: String?
    /// Why somebody saved it, in their words. "Beste Pastéis laut Blog"
    /// matters more than the name when you are choosing what to do with
    /// an afternoon (§9.2).
    let note: String?
    /// Where it came from — the article, the map link (§9.2).
    let sourceUrl: String?
    /// True when no OSM entry matched: opening hours and category are
    /// unknown rather than known-and-boring (§10.4).
    let unmatched: Bool?

    var id: String { osmRef }
    var isManual: Bool { origin == "manual" }
    var displayName: String { name ?? TripCategory.unnamed(category) }
    var coordinate: TripCoordinate { TripCoordinate(lat: lat, lon: lon) }
}

struct TripCoordinate: Codable, Sendable, Equatable {
    let lat: Double
    let lon: Double
}

enum TripStopStatus: String, Sendable {
    case planned, done, skipped

    init(raw: String) {
        self = TripStopStatus(rawValue: raw) ?? .planned
    }
}

/// How the group gets around on a leg (§4.2). Unknown values decode to
/// `foot` rather than failing: a mode the app has not learned about yet
/// is still a leg worth showing.
enum TripTransportMode: String, CaseIterable, Sendable {
    case foot, bike, transit, car

    init(raw: String) {
        self = TripTransportMode(rawValue: raw) ?? .foot
    }

    var systemImage: String {
        switch self {
        case .foot:    return "figure.walk"
        case .bike:    return "bicycle"
        case .transit: return "tram"
        case .car:     return "car"
        }
    }

    var label: String {
        switch self {
        case .foot:    return "zu Fuß"
        case .bike:    return "mit dem Rad"
        // Not "mit Öffentlichen": the planner walks any hop that is
        // quicker on foot than by tram, which is most hops in an old
        // town. Naming only half of that would make the choice read
        // like a promise never to walk again.
        case .transit: return "ÖPNV & zu Fuß"
        case .car:     return "mit dem Auto"
        }
    }

    /// The line under the option: what choosing it actually does to the
    /// plan. Short enough for a picker row.
    var hint: String {
        switch self {
        case .foot:    return "Alles im Laufradius"
        case .bike:    return "Räder sind immer dabei"
        case .transit: return "Kurze Wege laufen, lange fahren"
        case .car:     return "Mit Parken gerechnet"
        }
    }
}

/// Minutes past midnight, the planner's unit for a time of day (§4.4).
/// Kept here rather than as a `Date` on purpose: a fixpoint is "the
/// 18:40 train", not an instant on a global clock, and formatting it
/// through a timezone would move it.
enum TripClock {
    static func format(_ minutes: Int) -> String {
        let wrapped = ((minutes % 1440) + 1440) % 1440
        return String(format: "%02d:%02d", wrapped / 60, wrapped % 60)
    }

    /// "3 h 20" / "45 min" — durations as they read on a block card.
    static func duration(_ minutes: Int) -> String {
        if minutes < 60 { return "\(minutes) min" }
        let hours = minutes / 60
        let rest = minutes % 60
        return rest == 0 ? "\(hours) h" : "\(hours) h \(rest)"
    }
}

// MARK: - Request and response envelopes

struct TripPlanResponse: Codable, Sendable {
    let plan: TripPlan
    /// Blocks the fixpoints left no room for. Reported rather than
    /// silently absent (§8.3).
    let droppedBlocks: [TripDroppedBlock]?
}

struct TripDroppedBlock: Codable, Sendable {
    let legIndex: Int
    let dayIndex: Int
    let id: String
    let label: String
    let reason: String
}

/// What a redistribution moved out of the day (§5). The sentence the
/// app shows is built from this, not from a count: "Museum raus,
/// rutscht auf Freitag" is what makes the change reviewable.
struct TripDisplacedStop: Codable, Identifiable, Sendable {
    let osmRef: String
    let name: String?

    var id: String { osmRef }
    var displayName: String { name ?? "Unbenannter Ort" }
}

struct RedistributeResponse: Codable, Sendable {
    let plan: TripPlan
    let displaced: [TripDisplacedStop]
}

struct MoveStopResponse: Codable, Sendable {
    let plan: TripPlan
    /// Blocks now over their budget — the ones the day view turns red.
    let overfullBlockIds: [String]
}
