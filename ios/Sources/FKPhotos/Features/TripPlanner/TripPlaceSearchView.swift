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
    /// Told after every spot that went in, so the screen behind — the
    /// leg's candidate count, the pool, the ballot — shows it at once
    /// rather than after the next reload of the trip.
    private let onChanged: (() -> Void)?
    @Environment(\.dismiss) private var dismiss

    init(planId: Int, legIndex: Int? = nil, ideas: Bool = false, onChanged: (() -> Void)? = nil) {
        _model = State(initialValue: TripPlaceSearchViewModel(planId: planId, legIndex: legIndex, ideas: ideas))
        self.onChanged = onChanged
    }

    var body: some View {
        List {
            if model.legIndex != nil {
                // Three ways to look (ideas plan, stage 2): what the
                // place is known for, a name, a kind of place.
                Picker("Suchen", selection: $model.mode) {
                    ForEach(TripPlaceSearchMode.allCases) { mode in
                        Text(mode.label).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }

            switch model.mode {
            case .highlights: highlightsSection
            case .name: nameSection
            case .category: categorySection
            }

            // Not a footnote: a search that silently skipped a region
            // would answer "nichts gefunden" for a place that is there.
            ForEach(model.unavailableLegs, id: \.self) { leg in
                Label("Aufenthalt \(leg + 1) konnte nicht durchsucht werden.",
                      systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .modifier(NameSearchField(model: model))
        .navigationTitle("Ort suchen")
        .plannerErrorBanner(model.errorMessage, dismiss: { model.errorMessage = nil })
        .navigationBarTitleDisplayMode(.inline)
        .task(id: model.mode) {
            if model.mode == .highlights && !model.didLoadHighlights { await model.loadHighlights() }
        }
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Fertig") { dismiss() }
            }
        }
    }

    // MARK: - Highlights

    @ViewBuilder
    private var highlightsSection: some View {
        if model.isLoadingHighlights && model.highlights.isEmpty {
            HStack { ProgressView(); Text("Wird geladen…") }
        }
        if model.highlightsSorting {
            Label("Die Reihenfolge wird noch sortiert; bis dahin nach Bekanntheit.",
                  systemImage: "arrow.up.arrow.down")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        if model.highlightsUnavailable {
            Label("Die Umgebung konnte gerade nicht durchsucht werden.", systemImage: "exclamationmark.triangle")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else if model.didLoadHighlights && model.highlights.isEmpty && !model.isLoadingHighlights {
            ContentUnavailableView {
                Label("Keine Highlights", systemImage: "star")
            } description: {
                Text("Über diese Gegend wissen die offenen Daten wenig. Sucht nach einem Namen oder einer Kategorie.")
            }
        }
        ForEach(model.highlights) { highlight in
            highlightRow(highlight)
        }
        if model.highlightsHaveMore {
            Button {
                Task { await model.loadHighlights(more: true) }
            } label: {
                if model.isLoadingHighlights {
                    HStack { ProgressView(); Text("Wird geladen…") }
                } else {
                    Text("Mehr")
                }
            }
        }
    }

    @ViewBuilder
    private func highlightRow(_ highlight: TripHighlight) -> some View {
        HStack(alignment: .top, spacing: 12) {
            if let picture = highlight.picture {
                TripSpotThumbnail(image: picture, height: 64, width: 64)
            } else {
                RoundedRectangle(cornerRadius: 8)
                    .fill(.quaternary)
                    .frame(width: 64, height: 64)
                    .overlay(Image(systemName: "photo").foregroundStyle(.secondary))
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(highlight.name ?? highlight.osmRef).font(.headline)
                if let line = highlight.reason ?? highlight.description?.text {
                    Text(line)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Text(TripSearchedPlace.distanceText(highlight.distanceM))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                addControl(highlight.asSearched(legIndex: model.legIndex ?? 0))
            }
        }
        .padding(.vertical, 2)
    }

    // MARK: - Name

    @ViewBuilder
    private var nameSection: some View {
        if model.isSearching {
            HStack { ProgressView(); Text("Wird gesucht…") }
        }
        if !model.hasSearched && !model.isSearching {
            // Something before the first search: the screen used to
            // be a title over nothing.
            ContentUnavailableView {
                Label("Nach Namen suchen", systemImage: "magnifyingglass")
            } description: {
                Text(model.ideas
                     ? "Ein Museum, ein Café, ein Aussichtspunkt — was ihr übernehmt, kommt zu den Ideen dieses Aufenthalts."
                     : "Ein Museum, ein Café, ein Aussichtspunkt — was ihr findet, kommt zu "
                     + "den Kandidaten dieses Aufenthalts.")
            }
        }
        if model.hasSearched && model.results.isEmpty && !model.isSearching {
            Text("Nichts gefunden. Vielleicht heißt der Ort in OpenStreetMap anders.")
                .foregroundStyle(.secondary)
        }
        resultRows
    }

    // MARK: - Category

    @ViewBuilder
    private var categorySection: some View {
        if let category = model.category {
            Button {
                model.clearCategory()
            } label: {
                Label("Alle Kategorien", systemImage: "chevron.left")
            }
            Text(category.label).font(.headline)
            if model.isSearching {
                HStack { ProgressView(); Text("Wird gesucht…") }
            }
            if model.hasSearched && model.results.isEmpty && !model.isSearching {
                Text("In der Nähe nichts von dieser Art.")
                    .foregroundStyle(.secondary)
            }
            resultRows
        } else {
            ForEach(TripPlaceCategory.all) { category in
                Button {
                    Task { await model.search(category: category) }
                } label: {
                    Label(category.label, systemImage: category.systemImage)
                }
            }
        }
    }

    @ViewBuilder
    private var resultRows: some View {
        ForEach(model.results) { place in
            row(place)
        }
        if model.hasMore {
            Text("Es gibt mehr Treffer — genauer suchen hilft.")
                .font(.footnote)
                .foregroundStyle(.secondary)
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

            addControl(place)
        }
        .padding(.vertical, 2)
    }

    /// "Zur Reise", or what already happened to the place. One control
    /// for every way of looking, so a place reads the same everywhere.
    @ViewBuilder
    private func addControl(_ place: TripSearchedPlace) -> some View {
        if place.planned {
            Label("Schon eingeplant", systemImage: "checkmark.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else if place.inPool {
            Label(model.ideas ? "In der Reise" : "Schon bei den Kandidaten",
                  systemImage: model.ideas ? "lightbulb" : "tray.full")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else if let outcome = model.added[place.osmRef] {
            Label(outcome, systemImage: "checkmark.circle.fill")
                .font(.caption)
                .foregroundStyle(.green)
        } else {
            if model.addingRef == place.osmRef {
                HStack { ProgressView(); Text("Wird übernommen…") }
                    .font(.callout)
            } else if model.ideas {
                // A tap takes it as „Will“; holding asks how much it
                // matters (ideas plan, stage 3).
                Menu {
                    ForEach(TripIdeaPriority.allCases) { priority in
                        Button {
                            add(place, priority: priority)
                        } label: {
                            Label("Zur Reise · \(priority.label)", systemImage: priority.systemImage)
                        }
                    }
                } label: {
                    Label("Zur Reise", systemImage: "plus.circle")
                } primaryAction: {
                    add(place, priority: nil)
                }
                .buttonStyle(.borderless)
                .font(.callout)
            } else {
                Button {
                    add(place, priority: nil)
                } label: {
                    Label("Zu den Kandidaten", systemImage: "plus.circle")
                }
                .buttonStyle(.borderless)
                .font(.callout)
            }
        }
    }
}

extension TripPlaceSearchView {
    fileprivate func add(_ place: TripSearchedPlace, priority: TripIdeaPriority?) {
        Task {
            await model.add(place, priority: priority)
            if model.added[place.osmRef] != nil { onChanged?() }
        }
    }
}

/// The search field belongs to the name search only: on the highlights
/// and the categories it would be a box that does nothing.
private struct NameSearchField: ViewModifier {
    @Bindable var model: TripPlaceSearchViewModel

    func body(content: Content) -> some View {
        if model.mode == .name {
            content
                .searchable(text: $model.query, prompt: "Name des Ortes")
                .onSubmit(of: .search) { Task { await model.search() } }
        } else {
            content
        }
    }
}
