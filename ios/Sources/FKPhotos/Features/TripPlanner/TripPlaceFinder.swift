import CoreLocation
import MapKit
import SwiftUI

/// Finding a place on the map, and picking one (§9.1, §15.3).
///
/// The search runs on the **device**, through MapKit: Apple geocodes,
/// fk-encore plans. The service says so itself — `/interpret` answers
/// with the place *name* a sentence used and no coordinates, because it
/// has no forward geocoder and will not invent one.
///
/// Its own type because three screens now need it: the first city of a
/// new trip, every further city, and moving a leg's anchor when the
/// hotel changed. The rule they all share is the one worth having in
/// one place — **a name is not a place**, so nothing is picked until a
/// coordinate has been chosen.
@Observable @MainActor
final class TripPlaceFinderModel {
    var query = ""
    private(set) var results: [TripPlace] = []
    private(set) var isSearching = false
    /// Nothing found and the search failing look different to the
    /// traveller: one means "try another name", the other "try again".
    private(set) var failed = false

    /// Cancels a search still in flight when a newer one starts, so a
    /// slow answer for "Lis" cannot land on top of "Lissabon".
    private var task: Task<Void, Never>?

    /// Look up what was typed.
    ///
    /// Deliberately explicit rather than search-as-you-type: each call
    /// is a network request on someone's holiday data plan, and the
    /// field is usually filled once.
    func search() {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        task?.cancel()
        guard !text.isEmpty else {
            results = []
            failed = false
            return
        }
        isSearching = true
        failed = false
        task = Task { [weak self] in
            let found = await Self.mapKitSearch(text)
            guard let self, !Task.isCancelled else { return }
            self.isSearching = false
            self.results = found ?? []
            self.failed = found == nil
        }
    }

    /// Put a name in the field and look it up. The traveller still
    /// confirms which of the answers it is.
    func lookUp(_ name: String) {
        query = name
        search()
    }

    func clearResults() {
        results = []
    }

    var canSearch: Bool {
        !query.trimmingCharacters(in: .whitespaces).isEmpty
    }

    nonisolated static func mapKitSearch(_ query: String) async -> [TripPlace]? {
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

    nonisolated static func place(from item: MKMapItem) -> TripPlace? {
        let coordinate = item.placemark.coordinate
        guard CLLocationCoordinate2DIsValid(coordinate) else { return nil }
        let name = item.name ?? item.placemark.locality ?? item.placemark.name
        guard let name, !name.isEmpty else { return nil }
        return TripPlace(
            name: name,
            subtitle: subtitle(for: item.placemark),
            latitude: coordinate.latitude,
            longitude: coordinate.longitude,
        )
    }

    /// Enough to tell two places of the same name apart, which is the
    /// only job this line has.
    nonisolated static func subtitle(for placemark: MKPlacemark) -> String? {
        let parts = [placemark.locality, placemark.administrativeArea, placemark.country]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
        var seen: [String] = []
        for part in parts where !seen.contains(part) { seen.append(part) }
        return seen.isEmpty ? nil : seen.joined(separator: ", ")
    }
}

/// The search field, the answers, and the pin once one is chosen.
///
/// Rows rather than a `Section`, so a caller can put it inside whatever
/// section its own screen needs.
struct TripPlaceFinderRows: View {
    @Bindable var model: TripPlaceFinderModel
    let picked: TripPlace?
    let onPick: (TripPlace) -> Void

    var body: some View {
        HStack {
            TextField("Stadt oder Ort", text: $model.query)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .onSubmit { model.search() }
            if model.isSearching {
                ProgressView()
            } else {
                Button("Suchen") { model.search() }
                    .buttonStyle(.borderless)
                    .disabled(!model.canSearch)
            }
        }

        ForEach(model.results, id: \.self) { place in
            Button {
                onPick(place)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(place.name).foregroundStyle(.primary)
                    if let subtitle = place.subtitle {
                        Text(subtitle).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }

        if model.failed {
            Text("Die Ortssuche hat nicht geantwortet. Noch einmal versuchen?")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }

        if let picked {
            TripPickedPlaceRow(place: picked)
        }
    }
}

/// A chosen place, with the map that makes "is that the right one?"
/// answerable at a glance rather than from a coordinate.
struct TripPickedPlaceRow: View {
    let place: TripPlace

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(place.name, systemImage: "mappin.circle.fill")
                .font(.headline)
            Map(initialPosition: .region(MKCoordinateRegion(
                center: CLLocationCoordinate2D(latitude: place.latitude,
                                               longitude: place.longitude),
                latitudinalMeters: 4_000,
                longitudinalMeters: 4_000,
            ))) {
                Marker(place.name, coordinate: CLLocationCoordinate2D(
                    latitude: place.latitude, longitude: place.longitude))
            }
            .frame(height: 160)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .allowsHitTesting(false)
        }
        .padding(.vertical, 4)
    }
}
