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
        if distanceM >= 1_000 {
            return "\(String(format: "%.1f", distanceM / 1_000).replacingOccurrences(of: ".", with: ",")) km"
        }
        return "\(Int(distanceM.rounded())) m"
    }
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
    private(set) var results: [TripSearchedPlace] = []
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
    private let legIndex: Int?

    init(planId: Int, legIndex: Int? = nil) {
        self.planId = planId
        self.legIndex = legIndex
    }

    func search() async {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count >= 2 else { return }
        isSearching = true
        defer {
            isSearching = false
            hasSearched = true
        }
        struct Body: Encodable {
            let query: String
            let legIndex: Int?
        }
        do {
            let response: TripSearchPlacesResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/search",
                body: Body(query: text, legIndex: legIndex),
            )
            results = response.results
            hasMore = response.hasMore
            unavailableLegs = response.unavailableLegs
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func add(_ place: TripSearchedPlace) async {
        addingRef = place.osmRef
        defer { addingRef = nil }
        do {
            let response: TripAddFindResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/finds",
                body: requestFor(place),
            )
            added[place.osmRef] = response.merged
                ? "mit einem vorhandenen Eintrag zusammengeführt"
                : "im Vorrat"
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
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
