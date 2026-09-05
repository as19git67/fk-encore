import Foundation

/// What the "new trip" screen has collected so far, and whether it is
/// enough to plan.
///
/// A plain value type, apart from the view, because the two questions
/// worth getting right here are decisions rather than layout: **when is
/// a draft ready**, and **what does a sentence the model read change
/// about it**. Both are testable this way and neither needs a running
/// app.
///
/// The one rule the whole screen turns on: a place name is not a place.
/// `POST /trip-planner/plans` wants an anchor, the service has no
/// forward geocoder, and inventing coordinates from "Lissabon" is the
/// confident guess §15.3 exists to forbid. So a draft is ready only
/// once a coordinate has been *chosen* — from a map search, from the
/// current location, or by dropping a pin. A sentence can fill in
/// everything else; it can never fill in that.
struct TripNewPlanDraft: Equatable {
    /// Set once a place was picked. Nil until then, and the only reason
    /// a filled-in draft may still not be plannable.
    var anchor: TripPlace?
    var title: String = ""
    var days: Int = 3
    var pace: TripPace = .normal
    var mode: TripTransportMode = .foot
    var radiusM: Int = 3_000
    var withChildren = false
    var limitedMobility = false
    var categories: [String] = []
    var interests: [String] = []
    var maxWalkMinutes: Int?
    /// The place name a sentence mentioned, kept so the search field can
    /// offer it and the traveller can confirm what it means.
    var placeHint: String?
    /// Whether the trip has a date at all. A plan for "some time" is a
    /// real plan (§4.2), so this is off by default rather than quietly
    /// dating every trip today.
    var isDated = false
    /// The first day, used only when `isDated`.
    var startDate = Date()

    /// Bounds mirror `constraints.ts`, so the screen refuses what the
    /// endpoint would refuse — with a stepper that stops rather than an
    /// error after the fact.
    static let minDays = 1
    static let maxDays = 14
    static let minRadiusM = 100
    static let maxRadiusM = 20_000

    var isPlannable: Bool { anchor != nil }

    /// What to call the trip when nobody said. The place is a better
    /// answer than "Reise", and it is not invented — it is what the
    /// traveller picked on the map.
    var effectiveTitle: String? {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        return anchor?.name
    }

    /// Fold in what the model understood, without touching the anchor.
    ///
    /// Every field is overwritten only where the sentence actually said
    /// something — a sentence about the pace must not reset the days
    /// back to the default. Values outside the bounds are clamped here
    /// as well as on the server: the point of this screen is that you
    /// see what will be planned before it is.
    mutating func apply(_ constraints: TripInterpretedConstraints) {
        if let title = constraints.title, !title.isEmpty { self.title = title }
        if let hint = constraints.placeHint, !hint.isEmpty { placeHint = hint }
        if let days = constraints.days {
            self.days = min(max(days, Self.minDays), Self.maxDays)
        }
        if let radius = constraints.radiusM {
            radiusM = min(max(radius, Self.minRadiusM), Self.maxRadiusM)
        }
        if let pace = constraints.pace.flatMap(TripPace.init(rawValue:)) { self.pace = pace }
        if let categories = constraints.categories, !categories.isEmpty {
            self.categories = categories
        }
        if let interests = constraints.interests, !interests.isEmpty {
            self.interests = interests
        }
        if let walk = constraints.maxWalkMinutes { maxWalkMinutes = walk }
        // Only ever switched on: "mit Kind" is something the sentence
        // adds, and its absence in a later sentence is not a statement
        // that the child stayed home.
        if constraints.group?.withChildren == true { withChildren = true }
        if constraints.group?.limitedMobility == true { limitedMobility = true }
    }

    /// The request body, as `CreatePlanRequest` expects it.
    ///
    /// Returns nil for a draft with no anchor rather than sending one
    /// the server will reject.
    func createRequest() -> TripCreatePlanRequest? {
        guard let anchor else { return nil }
        return TripCreatePlanRequest(
            title: effectiveTitle,
            legs: [
                TripCreatePlanRequest.Leg(
                    title: anchor.name,
                    anchor: .init(lat: anchor.latitude, lon: anchor.longitude),
                    mode: mode.rawValue,
                    days: days,
                    radiusM: radiusM,
                    // The date is what later lets the app know which day
                    // of the trip today is — there is no "start trip"
                    // button, and there should not be one.
                    startDate: isDated ? TripCalendar.isoDay(startDate) : nil,
                ),
            ],
            categories: categories.isEmpty ? nil : categories,
            interests: interests.isEmpty ? nil : interests,
            pace: pace.rawValue,
            group: (withChildren || limitedMobility)
                ? .init(withChildren: withChildren, limitedMobility: limitedMobility)
                : nil,
            maxWalkMinutes: maxWalkMinutes,
        )
    }
}

/// A place with a coordinate: what a map search or a dropped pin gives
/// back, and the only thing the planner accepts as an anchor.
struct TripPlace: Hashable, Sendable {
    var name: String
    /// The line under the name in a search result — a district, a
    /// country. Only ever shown, never sent.
    var subtitle: String?
    var latitude: Double
    var longitude: Double
}

enum TripPace: String, CaseIterable, Sendable {
    case relaxed
    case normal
    case packed

    var label: String {
        switch self {
        case .relaxed: return "Gemütlich"
        case .normal: return "Normal"
        case .packed: return "Viel sehen"
        }
    }
}

// MARK: - Wire types

/// The half of `/trip-planner/interpret` this screen uses.
struct TripInterpretedConstraints: Codable, Sendable {
    var title: String?
    var placeHint: String?
    var days: Int?
    var radiusM: Int?
    var categories: [String]?
    var interests: [String]?
    var pace: String?
    var group: Group?
    var maxWalkMinutes: Int?

    struct Group: Codable, Sendable {
        var withChildren: Bool?
        var limitedMobility: Bool?
    }
}

struct TripInterpretResponse: Codable, Sendable {
    let constraints: TripInterpretedConstraints
    /// What the model proposed that could not be used. Shown rather
    /// than dropped, so a misread sentence is visible (§8.3).
    let rejected: [String]
}

struct TripCreatePlanRequest: Encodable, Sendable {
    struct Coordinate: Encodable, Sendable {
        let lat: Double
        let lon: Double
    }

    struct Leg: Encodable, Sendable {
        let title: String?
        let anchor: Coordinate
        let mode: String
        let days: Int
        let radiusM: Int
        let startDate: String?
    }

    struct Group: Encodable, Sendable {
        let withChildren: Bool
        let limitedMobility: Bool
    }

    let title: String?
    let legs: [Leg]
    let categories: [String]?
    let interests: [String]?
    let pace: String
    let group: Group?
    let maxWalkMinutes: Int?
}

struct TripCreatePlanResponse: Decodable, Sendable {
    let plan: TripPlan
}
