import CoreLocation
import SwiftUI

/// Looking around an area, with no trip in sight (§9.2, §20).
///
/// Thin like the rest of the planner's view models: which spots an area
/// holds, how they rank and what an empty answer means are all decided
/// on the server, and this fetches them. What lives here is the state a
/// screen needs — where we are looking, which interests are ticked, and
/// which rows have since been collected.
///
/// **Nothing pure lives here.** Wording and constants belong on
/// `TripExploreDefaults` and on the response: this class is
/// `@MainActor`, so anything put on it becomes actor-isolated and
/// unreachable from a nonisolated test.
@Observable @MainActor
final class TripExploreViewModel {
    /// Where the browse is centred. Nil until somebody says.
    var area: TripExploreArea?
    var query = ""
    var radiusM = TripExploreDefaults.radiusM
    /// Which collection a find goes into. Nil means one's own.
    var ownerId: Int?

    private(set) var interests: [TripInterestOption] = []
    var chosenInterests: Set<String> = []

    private(set) var spots: [TripExploredSpot] = []
    private(set) var hasMore = false
    private(set) var regionMissing = false
    /// Why the list is empty, in the server's words.
    private(set) var note: String?
    private(set) var isLoading = false
    private(set) var isLocating = false
    var errorMessage: String?
    /// What the last "merken" did, in the server's words.
    var lastAddition: String?
    /// Which rows have been collected in this session, so the mark
    /// appears without re-running the whole search.
    private(set) var collectedNow: Set<String> = []
    private(set) var addingRef: String?

    /// True once a search has run, so "nothing found" and "nothing asked
    /// for yet" can look different.
    private(set) var hasSearched = false

    // MARK: - The vocabulary

    /// The interests the planner can actually match.
    ///
    /// A failure here is silent on purpose: the chips are how the
    /// browse is narrowed, and a browse works without narrowing. An
    /// error banner over a list that is about to fill up anyway would
    /// be noise.
    func loadInterests() async {
        guard interests.isEmpty else { return }
        // The same shape the trip settings screen reads, declared where
        // it is used rather than shared: two callers of one endpoint do
        // not need a type between them, and `TripInterestOption` — the
        // part that must not drift — is already one type for both.
        struct Response: Decodable { let interests: [TripInterestOption] }
        do {
            let response: Response = try await APIClient.shared.get("/trip-planner/interests")
            interests = response.interests
        } catch {
            interests = []
        }
    }

    // MARK: - Where to look

    /// Centre the browse on where the phone is.
    func useCurrentLocation(locationProvider: TripLocationProvider? = nil) async {
        isLocating = true
        defer { isLocating = false }

        let provider = locationProvider
            ?? TripLocationProvider(accuracy: kCLLocationAccuracyHundredMeters)
        guard let location = await provider.currentLocation() else {
            errorMessage = "Ohne Standort lässt sich nicht sagen, was hier in der Nähe ist."
            return
        }
        area = TripExploreArea(
            label: "Hier",
            lat: location.coordinate.latitude,
            lon: location.coordinate.longitude,
        )
        await load()
    }

    /// Centre it on a place somebody picked out of the map search.
    func use(_ place: TripPlace) async {
        area = TripExploreArea(
            label: place.name,
            lat: place.latitude,
            lon: place.longitude,
        )
        await load()
    }

    // MARK: - Looking

    func load() async {
        guard let area else { return }
        isLoading = true
        defer { isLoading = false }

        struct Body: Encodable {
            struct Position: Encodable { let lat: Double; let lon: Double }
            let position: Position
            let radiusM: Int
            let query: String?
            let interests: [String]
            let ownerId: Int?
        }
        do {
            let response: TripExploreResponse = try await APIClient.shared.post(
                "/trip-planner/explore",
                body: Body(
                    position: .init(lat: area.lat, lon: area.lon),
                    radiusM: radiusM,
                    query: query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? nil : query,
                    // Sorted so the same choice sends the same request —
                    // a set has no order, and a request that differs by
                    // nothing but field order defeats every cache.
                    interests: chosenInterests.sorted(),
                    ownerId: ownerId,
                ),
            )
            spots = response.spots
            hasMore = response.hasMore
            regionMissing = response.regionMissing
            note = response.note
            errorMessage = nil
            hasSearched = true
            collectedNow = []
        } catch {
            errorMessage = "Die Suche hat nicht geantwortet. Noch einmal versuchen?"
        }
    }

    // MARK: - Taking one along

    /// Put a found spot into the collection — no trip involved (§20).
    ///
    /// The duration goes along even though the server could look it up:
    /// both figures come from the same category table, and sending it
    /// means an entry can never be refused for want of one — which is
    /// exactly how "merken" came to look as though it had worked and
    /// changed nothing.
    func collect(_ spot: TripExploredSpot) async {
        addingRef = spot.osmRef
        defer { addingRef = nil }

        struct Body: Encodable {
            let lat: Double
            let lon: Double
            let ownerId: Int?
            let name: String?
            let dwellMinutes: Int
        }
        do {
            let response: TripIdeaAddResponse = try await APIClient.shared.post(
                "/trip-planner/ideas",
                body: Body(
                    lat: spot.lat,
                    lon: spot.lon,
                    ownerId: ownerId,
                    name: spot.name,
                    dwellMinutes: spot.dwellMinutes,
                ),
            )
            lastAddition = response.sentence
            errorMessage = nil
            collectedNow.insert(spot.osmRef)
        } catch {
            errorMessage = "\(spot.displayName) ließ sich nicht merken."
        }
    }

    /// Is this one in the collection — either already, or since we looked?
    func isCollected(_ spot: TripExploredSpot) -> Bool {
        spot.collected || collectedNow.contains(spot.osmRef)
    }
}
