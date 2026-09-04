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
    let legs: [TripLeg]

    enum CodingKeys: String, CodingKey {
        case id, ownerId, title, legs
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
    /// "YYYY-MM-DD", or nil when the trip has no dates yet.
    let startDate: String?
    let days: [TripDay]
    /// Scored candidates not placed in any day — the working set the
    /// whole replanning mechanic turns on (§5), and at trip resolution
    /// the actual planning result (§4.3).
    let pool: [TripCandidate]

    var transportMode: TripTransportMode { TripTransportMode(raw: mode) }
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

    var id: Int { rowId }
    var stopStatus: TripStopStatus { TripStopStatus(raw: status) }
    var coordinate: TripCoordinate { TripCoordinate(lat: lat, lon: lon) }
    /// What to show when OpenStreetMap has no name for the place. Never
    /// invented — an unnamed spot says so (§15.3).
    var displayName: String { name ?? "Unbenannter Ort" }
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

    var id: String { osmRef }
    var displayName: String { name ?? "Unbenannter Ort" }
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
enum TripTransportMode: String, Sendable {
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
        case .transit: return "mit Öffentlichen"
        case .car:     return "mit dem Auto"
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
