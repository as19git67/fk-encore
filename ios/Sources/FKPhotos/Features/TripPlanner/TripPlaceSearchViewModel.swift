import SwiftUI

/// One search result, as the server describes it.
struct TripSearchedPlace: Codable, Identifiable, Sendable {
    let osmRef: String
    let name: String?
    let lat: Double
    let lon: Double
    let distanceM: Double?
    let categories: [String]
    let legIndex: Int
    /// Straight from OSM and unverified — absent means unknown, not
    /// "closed". Shown as it is written rather than interpreted.
    let openingHours: String?
    let phone: String?
    let website: String?
    /// What the planner would allow, from the category. Null when no
    /// category has a default, and then a duration has to be given.
    let dwellMinutes: Int?
    let inPool: Bool
    let planned: Bool

    var id: String { osmRef }

    /// "300 m" / "4,2 km" — how far out of the way it is, from the
    /// leg's own base rather than from where you happen to stand.
    var distanceLabel: String? {
        guard let distanceM else { return nil }
        return Self.distanceText(distanceM)
    }

    static func distanceText(_ distanceM: Double) -> String {
        if distanceM >= 1_000 {
            return "\(String(format: "%.1f", distanceM / 1_000).replacingOccurrences(of: ".", with: ",")) km"
        }
        return "\(Int(distanceM.rounded())) m"
    }
}

/// One of a stay's highlights (ideas plan, stage 2): a place the open
/// data knows well, with its picture and one line about it.
struct TripHighlight: Codable, Identifiable, Sendable {
    let osmRef: String
    let name: String?
    let localName: String?
    let lat: Double
    let lon: Double
    let category: String
    let distanceM: Double
    let dwellMinutes: Int
    /// The model's sentence, else the best open-data reason.
    let reason: String?
    let picture: TripRoutePhoto?
    let description: TripSpotDescription?
    let wikipediaUrl: String?
    let inPool: Bool
    let planned: Bool

    var id: String { osmRef }

    /// The same row the name search shows, so adding works one way.
    func asSearched(legIndex: Int) -> TripSearchedPlace {
        TripSearchedPlace(
            osmRef: osmRef, name: name, lat: lat, lon: lon, distanceM: distanceM,
            categories: [category], legIndex: legIndex, openingHours: nil, phone: nil, website: nil,
            dwellMinutes: dwellMinutes, inPool: inPool, planned: planned,
        )
    }
}

struct TripHighlightsResponse: Codable, Sendable {
    let results: [TripHighlight]
    let hasMore: Bool
    /// The model has not ordered this stay yet; the list is by fame until then.
    let sorting: Bool
    let unavailable: Bool
}

/// The three ways to look (ideas plan, stage 2).
enum TripPlaceSearchMode: String, CaseIterable, Identifiable, Sendable {
    case highlights, name, category

    var id: String { rawValue }

    var label: String {
        switch self {
        case .highlights: "Highlights"
        case .name: "Suche"
        case .category: "Kategorien"
        }
    }
}

/// A category that is one tap: "alle Aussichtspunkte". The ids are the
/// geo service's own.
struct TripPlaceCategory: Identifiable, Hashable, Sendable {
    let id: String
    let label: String
    let systemImage: String

    static let all: [TripPlaceCategory] = [
        .init(id: "museum", label: "Museen", systemImage: "building.columns"),
        .init(id: "sight", label: "Sehenswürdigkeiten", systemImage: "star"),
        .init(id: "viewpoint", label: "Aussichtspunkte", systemImage: "binoculars"),
        .init(id: "worship", label: "Kirchen und Tempel", systemImage: "building"),
        .init(id: "outdoors", label: "Parks und Natur", systemImage: "leaf"),
        .init(id: "market", label: "Märkte", systemImage: "basket"),
        .init(id: "theatre", label: "Theater", systemImage: "theatermasks"),
        .init(id: "zoo", label: "Zoos", systemImage: "pawprint"),
        .init(id: "bath", label: "Bäder", systemImage: "drop"),
        .init(id: "producers", label: "Erzeuger", systemImage: "cart"),
    ]
}

struct TripSearchPlacesResponse: Codable, Sendable {
    let results: [TripSearchedPlace]
    let hasMore: Bool
    /// Legs whose region could not be searched. Shown, because "nothing
    /// found" and "one region was unreachable" are different answers.
    let unavailableLegs: [Int]
}

/// The state behind the search screen.
///
/// Adding goes to the same `POST …/finds` every other way in uses, so
/// the five rules of §9.2 are decided once. The only thing decided here
/// is what to send: the duration comes from the category where OSM has
/// one, and is left out otherwise so the server asks rather than the
/// app inventing a number.
@Observable @MainActor
final class TripPlaceSearchViewModel {
    var query = ""
    var mode: TripPlaceSearchMode
    private(set) var results: [TripSearchedPlace] = []
    private(set) var highlights: [TripHighlight] = []
    private(set) var highlightsHaveMore = false
    private(set) var highlightsSorting = false
    private(set) var highlightsUnavailable = false
    private(set) var isLoadingHighlights = false
    private(set) var didLoadHighlights = false
    private(set) var category: TripPlaceCategory?
    private(set) var hasMore = false
    private(set) var unavailableLegs: [Int] = []
    private(set) var isSearching = false
    /// False until a search has actually run, so the empty list does not
    /// say "nothing found" before anything was looked for.
    private(set) var hasSearched = false
    private(set) var addingRef: String?
    private(set) var added: [String: String] = [:]
    var errorMessage: String?

    /// Offered when a place has no category the planner knows a
    /// duration for. On screen and changeable — it reaches the server
    /// only because somebody left it there.
    static let fallbackDwellMinutes = 45

    private let planId: Int
    let legIndex: Int?
    /// A trip of ideas says "Zur Reise"; an older trip "Zu den Kandidaten".
    let ideas: Bool

    init(planId: Int, legIndex: Int? = nil, ideas: Bool = false) {
        self.planId = planId
        self.legIndex = legIndex
        self.ideas = ideas
        // Highlights need one stay to be about; a search for the whole
        // trip starts at the name.
        self.mode = legIndex == nil ? .name : .highlights
    }

    /// The highlights, first page or the next one ("Mehr").
    func loadHighlights(more: Bool = false) async {
        guard let legIndex, !isLoadingHighlights else { return }
        isLoadingHighlights = true
        defer {
            isLoadingHighlights = false
            didLoadHighlights = true
        }
        struct Body: Encodable {
            let legIndex: Int
            let offset: Int
        }
        do {
            let response: TripHighlightsResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/highlights",
                body: Body(legIndex: legIndex, offset: more ? highlights.count : 0),
            )
            highlights = more ? highlights + response.results : response.results
            highlightsHaveMore = response.hasMore
            highlightsSorting = response.sorting
            highlightsUnavailable = response.unavailable
            errorMessage = nil
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    /// Every place of one category around the stay, no name needed.
    func search(category: TripPlaceCategory) async {
        self.category = category
        await run(query: "", categories: [category.id])
    }

    func search() async {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count >= 2 else { return }
        await run(query: text, categories: nil)
    }

    private func run(query text: String, categories: [String]?) async {
        isSearching = true
        defer {
            isSearching = false
            hasSearched = true
        }
        struct Body: Encodable {
            let query: String
            let legIndex: Int?
            let categories: [String]?
        }
        do {
            let response: TripSearchPlacesResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/search",
                body: Body(query: text, legIndex: legIndex, categories: categories),
            )
            results = response.results
            hasMore = response.hasMore
            unavailableLegs = response.unavailableLegs
            errorMessage = nil
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    func add(_ place: TripSearchedPlace, priority: TripIdeaPriority? = nil) async {
        addingRef = place.osmRef
        defer { addingRef = nil }
        var request = requestFor(place)
        request.priority = priority?.rawValue
        do {
            let response: TripAddFindResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/finds",
                body: request,
            )
            added[place.osmRef] = response.merged
                ? "mit einem vorhandenen Eintrag zusammengeführt"
                : (ideas ? "in der Reise" : "bei den Kandidaten")
            errorMessage = nil
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    /// Leaving the category list: back to the categories, not a stale result.
    func clearCategory() {
        category = nil
        results = []
        hasSearched = false
    }

    /// What to send for one search result.
    ///
    /// Internal so it can be tested: whether a duration is sent is the
    /// difference between using OpenStreetMap's own default and
    /// overriding it with a guess.
    func requestFor(_ place: TripSearchedPlace) -> TripAddFindRequest {
        TripAddFindRequest(
            lat: place.lat,
            lon: place.lon,
            name: place.name,
            // A search result carries no reason — nobody wrote one.
            // Inventing "gefunden über die Suche" would fill the field
            // the plan uses for "warum hier?" with nothing.
            note: nil,
            sourceUrl: nil,
            legIndex: place.legIndex,
            // The server derives it from the category where it can. Only
            // where it cannot does a number have to travel.
            dwellMinutes: place.dwellMinutes == nil ? Self.fallbackDwellMinutes : nil,
        )
    }
}
