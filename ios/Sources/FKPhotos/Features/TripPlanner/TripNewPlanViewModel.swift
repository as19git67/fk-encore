import CoreLocation
import MapKit
import SwiftUI

/// The "new trip" screen's state: searching for a place, reading a
/// sentence, and creating the plan.
///
/// Place search runs on the **device**, through MapKit, and that is the
/// same division of labour §9.1 sets out rather than a shortcut: Apple
/// geocodes and rates, fk-encore plans. The service says so itself —
/// `/trip-planner/interpret` returns the place *name* a sentence used
/// and no coordinates, because it has no forward geocoder and will not
/// invent one.
///
/// The sentence is an accelerator, never the way in. The form below it
/// stands on its own, so a trip can be started with the language model
/// offline — which is the normal state of a self-hosted box that has
/// not warmed a model up yet.
@Observable @MainActor
final class TripNewPlanViewModel {
    var draft = TripNewPlanDraft()

    /// What is typed in the place field. Kept apart from the picked
    /// place: typing again after picking should not silently unpick.
    var placeQuery = ""
    private(set) var searchResults: [TripPlace] = []
    private(set) var isSearching = false
    private(set) var searchFailed = false

    /// The sentence, and what the model made of it.
    var sentence = ""
    private(set) var isInterpreting = false
    private(set) var rejected: [String] = []
    /// Set when the model could not be reached. A state, not a fault of
    /// the request — the form still works.
    private(set) var interpretUnavailable: String?

    private(set) var isCreating = false
    var errorMessage: String?

    /// Cancels a search still in flight when a newer one starts, so a
    /// slow answer for "Lis" cannot land on top of "Lissabon".
    private var searchTask: Task<Void, Never>?

    // MARK: - Place search

    /// Look up what was typed, through MapKit.
    ///
    /// Deliberately explicit rather than search-as-you-type: each call
    /// is a network request on someone's holiday data plan, and the
    /// field is usually filled once.
    func searchPlaces() {
        let query = placeQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        searchTask?.cancel()
        guard !query.isEmpty else {
            searchResults = []
            searchFailed = false
            return
        }
        isSearching = true
        searchFailed = false
        searchTask = Task { [weak self] in
            let found = await Self.mapKitSearch(query)
            guard let self, !Task.isCancelled else { return }
            self.isSearching = false
            self.searchResults = found ?? []
            // No results and a failure look different to the traveller:
            // one means "try another name", the other "try again".
            self.searchFailed = found == nil
        }
    }

    func pick(_ place: TripPlace) {
        draft.anchor = place
        placeQuery = place.name
        searchResults = []
    }

    /// Take the place name a sentence mentioned into the search field
    /// and look it up — the traveller still confirms which one it is.
    func searchPlaceHint() {
        guard let hint = draft.placeHint, !hint.isEmpty else { return }
        placeQuery = hint
        searchPlaces()
    }

    private nonisolated static func mapKitSearch(_ query: String) async -> [TripPlace]? {
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = query
        do {
            let response = try await MKLocalSearch(request: request).start()
            return response.mapItems.compactMap(place(from:))
        } catch {
            // MapKit reports "nothing found" as an error too. Both end
            // up here; the caller shows "nichts gefunden" either way
            // once the list is empty.
            return nil
        }
    }

    private nonisolated static func place(from item: MKMapItem) -> TripPlace? {
        let coordinate = item.placemark.coordinate
        guard CLLocationCoordinate2DIsValid(coordinate) else { return nil }
        let name = item.name ?? item.placemark.locality ?? item.placemark.name
        guard let name, !name.isEmpty else { return nil }
        return TripPlace(
            name: name,
            subtitle: Self.subtitle(for: item.placemark),
            latitude: coordinate.latitude,
            longitude: coordinate.longitude,
        )
    }

    /// Enough to tell two places of the same name apart, which is the
    /// only job this line has.
    private nonisolated static func subtitle(for placemark: MKPlacemark) -> String? {
        let parts = [placemark.locality, placemark.administrativeArea, placemark.country]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
        var seen: [String] = []
        for part in parts where !seen.contains(part) { seen.append(part) }
        return seen.isEmpty ? nil : seen.joined(separator: ", ")
    }

    // MARK: - The sentence

    func interpretSentence() async {
        let text = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        isInterpreting = true
        interpretUnavailable = nil
        defer { isInterpreting = false }
        struct Body: Encodable { let text: String }
        do {
            let response: TripInterpretResponse =
                try await APIClient.shared.post("/trip-planner/interpret", body: Body(text: text))
            draft.apply(response.constraints)
            rejected = response.rejected
            // The place still has to be confirmed on the map: a name is
            // not a coordinate, and this screen never pretends it is.
            if draft.anchor == nil { searchPlaceHint() }
        } catch {
            interpretUnavailable = error.localizedDescription
        }
    }

    // MARK: - Creating

    /// Create the plan and answer its id, or nil when it failed.
    func create() async -> Int? {
        guard let body = draft.createRequest() else { return nil }
        isCreating = true
        defer { isCreating = false }
        do {
            let response: TripCreatePlanResponse =
                try await APIClient.shared.post("/trip-planner/plans", body: body)
            errorMessage = nil
            return response.plan.id
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }
}
