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
    /// The cities of the trip, in order (§4.2). Always at least one —
    /// index zero is "the place" for a single-city trip, and the screen
    /// edits it in exactly the same fields it always did.
    var legs: [TripDraftLeg] = [TripDraftLeg()]
    var title: String = ""
    var pace: TripPace = .normal
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

    /// The first leg, as the screen's original fields.
    ///
    /// Kept as accessors rather than removed: the place search, the
    /// stepper and the sentence all talk about "the trip's place" and
    /// "how long", and for a one-city trip that is exactly leg zero.
    /// A second set of names for the same value would be the start of
    /// two of them drifting.
    var anchor: TripPlace? {
        get { legs.first?.place }
        set { legs[0].place = newValue }
    }

    var days: Int {
        get { legs.first?.days ?? 1 }
        set { legs[0].days = newValue }
    }

    var mode: TripTransportMode {
        get { legs.first?.mode ?? .foot }
        set { legs[0].mode = newValue }
    }

    var radiusM: Int {
        get { legs.first?.radiusM ?? Self.minRadiusM }
        set { legs[0].radiusM = newValue }
    }

    /// Bounds mirror `constraints.ts`, so the screen refuses what the
    /// endpoint would refuse — with a stepper that stops rather than an
    /// error after the fact.
    static let minDays = 1
    static let maxDays = 14
    static let minRadiusM = 100
    static let maxRadiusM = 20_000
    /// Mirrors the endpoint: more than this is a life, not a trip.
    static let maxLegs = 10

    /// Every city needs a coordinate — a half-picked second leg is not
    /// "plan what you have", it is a trip missing a city.
    var isPlannable: Bool { !legs.isEmpty && legs.allSatisfy { $0.place != nil } }

    /// "Beispielstadt → Musterstadt", or nil when nothing is picked.
    ///
    /// The cities, not the hotels: a trip anchored on "Hotel
    /// Beispielhof" is still a trip to Beispielstadt, and naming it
    /// after the hotel was what one field for both produced.
    var routeLabel: String? {
        let names = legs.compactMap(\.effectiveTitle)
        return names.isEmpty ? nil : names.joined(separator: " → ")
    }

    /// What to call the trip when nobody said. The place is a better
    /// answer than "Reise", and it is not invented — it is what the
    /// traveller picked on the map.
    var effectiveTitle: String? {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        return routeLabel
    }

    /// How long the whole trip lasts.
    var totalDays: Int { legs.reduce(0) { $0 + $1.days } }

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
        guard isPlannable else { return nil }
        let wire: [TripCreatePlanRequest.Leg] = legs.enumerated().compactMap { index, leg in
            guard let place = leg.place else { return nil }
            return TripCreatePlanRequest.Leg(
                title: leg.effectiveTitle,
                anchor: .init(lat: place.latitude, lon: place.longitude),
                // The anchor's own name, kept apart from the city's:
                // picking a hotel on the map used to name the trip
                // after the hotel.
                anchorLabel: place.name,
                anchorRadiusM: leg.anchorIsApproximate ? leg.anchorRadiusM : nil,
                mode: leg.mode.rawValue,
                days: leg.days,
                radiusM: leg.radiusM,
                // Only the first leg carries a date: the server dates
                // the rest in sequence, and two sources for the same
                // fact is how they come to disagree.
                startDate: index == 0 && isDated ? TripCalendar.isoDay(startDate) : nil,
                // On the first city only the arrival is sent: there is
                // no earlier leg for a departure to shorten (§4.2).
                transfer: index == 0 ? leg.arrivalOnly : leg.transfer,
            )
        }
        guard wire.count == legs.count else { return nil }
        return TripCreatePlanRequest(
            title: effectiveTitle,
            legs: wire,
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
        let anchorLabel: String?
        let anchorRadiusM: Int?
        let mode: String
        let days: Int
        let radiusM: Int
        let startDate: String?
        let transfer: TripDraftTransfer?
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

/// One city of a trip being drafted (§4.2).
///
/// A leg is a place plus how long you stay and how you get around
/// *there* — arriving by car does not mean driving around the old
/// town, which is why the mode belongs here and not to the trip.
struct TripDraftLeg: Identifiable, Equatable {
    let id = UUID()
    /// What the city is called, when it is not simply the anchor's own
    /// name. Empty means "call it after the place I picked".
    var title: String = ""
    /// Set when nothing is booked yet and the base is only known as an
    /// area (§4.2): the planner reckons with the centroid, and the plan
    /// says so rather than claiming an address it does not have.
    var anchorIsApproximate = false
    var anchorRadiusM: Int = 1_500
    /// Nil until a coordinate was actually chosen. A name is not a
    /// place: the planner has no forward geocoder and inventing one is
    /// the confident guess §15.3 exists to forbid.
    var place: TripPlace?
    var days: Int = 3
    var mode: TripTransportMode = .foot
    var radiusM: Int = 3_000
    /// When you leave the city before this one, as a time of day. Nil
    /// when nobody knows yet — an unknown train is not a train at 00:00.
    var departAt: Date?
    /// When you reach this one. Set on the first city too: nobody
    /// transfers into the start of a holiday, but they do arrive, and a
    /// day one that starts at nine for a group landing at two is a
    /// morning the plan invented.
    var arriveAt: Date?

    /// What to call this city: what was typed, or the picked place's
    /// own name.
    var effectiveTitle: String? {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        return place?.name
    }

    /// Just the arrival, for the first city — where a departure has no
    /// earlier day to sit on.
    var arrivalOnly: TripDraftTransfer? {
        guard let arriveAt else { return nil }
        return TripDraftTransfer(
            departAt: nil, arriveAt: TripDraftTransfer.time(arriveAt), label: nil)
    }

    /// The journey into this leg, as the endpoint wants it, or nil when
    /// neither end is known.
    var transfer: TripDraftTransfer? {
        guard departAt != nil || arriveAt != nil else { return nil }
        return TripDraftTransfer(
            departAt: departAt.map(TripDraftTransfer.time(_:)),
            arriveAt: arriveAt.map(TripDraftTransfer.time(_:)),
            label: place?.name.isEmpty == false ? "Weiterreise nach \(place!.name)" : nil,
        )
    }
}

/// The journey between two legs, on the wire.
struct TripDraftTransfer: Encodable, Sendable, Equatable {
    let departAt: String?
    let arriveAt: String?
    let label: String?

    /// "HH:MM" in the traveller's own clock. A departure is a time on a
    /// timetable, not an instant on a global one, so no timezone maths
    /// happens here beyond reading the hour off the picker.
    static func time(_ date: Date) -> String {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }
}
