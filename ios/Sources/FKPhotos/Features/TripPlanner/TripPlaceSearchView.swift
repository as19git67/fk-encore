import SwiftUI

/// Searching for a place and putting it in the pool (§9.2, case 4).
///
/// The way in that has to work when nothing else does: no share sheet,
/// no map app, no language model, no article. You know what the place
/// is called, you type it, it goes in the pool.
///
/// Two things the list says out loud rather than by omission. A place
/// already in the plan is **marked, not hidden** — a silently shorter
/// list reads as "not in OpenStreetMap", which would be a lie. And a
/// region that could not be reached is named, because "nichts gefunden"
/// and "eine Region war nicht erreichbar" are different answers.
struct TripPlaceSearchView: View {
    @State private var model: TripPlaceSearchViewModel
    @Environment(\.dismiss) private var dismiss

    init(planId: Int, legIndex: Int? = nil) {
        _model = State(initialValue: TripPlaceSearchViewModel(planId: planId, legIndex: legIndex))
    }

    var body: some View {
        List {
            if model.isSearching {
                HStack { ProgressView(); Text("Wird gesucht…") }
            }

            if let errorMessage = model.errorMessage {
                Text(errorMessage).font(.footnote).foregroundStyle(.red)
            }

            if model.hasSearched && model.results.isEmpty && !model.isSearching {
                Text("Nichts gefunden. Vielleicht heißt der Ort in OpenStreetMap anders.")
                    .foregroundStyle(.secondary)
            }

            ForEach(model.results) { place in
                row(place)
            }

            if model.hasMore {
                Text("Es gibt mehr Treffer — genauer suchen hilft.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            // Not a footnote: a search that silently skipped a region
            // would answer "nichts gefunden" for a place that is there.
            ForEach(model.unavailableLegs, id: \.self) { leg in
                Label("Etappe \(leg + 1) konnte nicht durchsucht werden.",
                      systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .searchable(text: $model.query, prompt: "Name des Ortes")
        .onSubmit(of: .search) { Task { await model.search() } }
        .navigationTitle("Ort suchen")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Fertig") { dismiss() }
            }
        }
    }

    @ViewBuilder
    private func row(_ place: TripSearchedPlace) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(place.name ?? place.osmRef).font(.headline)
            HStack(spacing: 6) {
                if let distance = place.distanceLabel {
                    Text(distance)
                }
                if let hours = place.openingHours {
                    Text("·")
                    Text(hours).lineLimit(1)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            if place.planned {
                Label("Schon eingeplant", systemImage: "checkmark.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if place.inPool {
                Label("Schon im Vorrat", systemImage: "tray.full")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if let outcome = model.added[place.osmRef] {
                Label(outcome, systemImage: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.green)
            } else {
                Button {
                    Task { await model.add(place) }
                } label: {
                    if model.addingRef == place.osmRef {
                        HStack { ProgressView(); Text("Wird übernommen…") }
                    } else {
                        Label("In den Vorrat", systemImage: "plus.circle")
                    }
                }
                .buttonStyle(.borderless)
                .font(.callout)
            }
        }
        .padding(.vertical, 2)
    }
}
