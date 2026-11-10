import MapKit
import SwiftUI

/// The one way into a stay's days (reise-planen-und-unterwegs.md,
/// stage 4): a search field that takes a name, a category or a pasted
/// map link, chips for ideas, highlights, food and more, and a row per
/// place with "+ Tag n".
///
/// Without a query the stay's own ideas come first, then its
/// highlights by fame. "+ Tag n" puts a place on the day the server
/// suggests — the first with room on which it is open; a long press
/// offers every other day and "Als Idee behalten". A tap opens the
/// place at half height. The sheet stays open until "Fertig", so
/// several places go in one after another.
struct TripSpotPickerView: View {
    @State var viewModel: TripPlannerViewModel
    @State private var search: TripPlaceSearchViewModel

    @State private var chip: TripPickerChip = .all
    @State private var category: TripPlaceCategory?
    @State private var detail: TripPickerItem?
    /// What became of a row, so the list says what it did.
    @State private var done: [String: String] = [:]
    @State private var busy: String?
    @AppStorage("trip.spotPicker.layout") private var layout = Layout.list.rawValue
    @Environment(\.dismiss) private var dismiss

    private enum Layout: String { case list, map }

    init(viewModel: TripPlannerViewModel) {
        _viewModel = State(initialValue: viewModel)
        _search = State(initialValue: TripPlaceSearchViewModel(
            planId: viewModel.planId, legIndex: viewModel.legIndex, ideas: true))
    }

    private var legIndex: Int { viewModel.legIndex }

    private var link: TripSearchedPlace? {
        TripSpotPicker.linkPlace(search.query, legIndex: legIndex)
    }

    private var items: [TripPickerItem] {
        TripSpotPicker.items(
            chip: chip,
            query: search.query,
            ideas: viewModel.leg?.pool ?? [],
            highlights: search.highlights,
            results: search.results,
            link: link,
        )
    }

    var body: some View {
        NavigationStack {
            Group {
                if chip == .food, let leg = viewModel.leg {
                    food(leg)
                } else if layout == Layout.map.rawValue {
                    TripSpotPickerMap(
                        items: items,
                        leg: viewModel.leg,
                        open: { detail = $0 },
                        searchHere: { area in
                            search.area = area
                            Task { await reload() }
                        },
                    )
                } else {
                    list
                }
            }
            .safeAreaInset(edge: .top, spacing: 0) { chips }
            .searchable(text: $search.query, placement: .navigationBarDrawer(displayMode: .always),
                        prompt: "Name, Kategorie oder Karten-Link")
            .onSubmit(of: .search) { Task { await runQuery() } }
            .task(id: search.query) {
                // Typing pauses before it searches, as everywhere in the app.
                try? await Task.sleep(for: .milliseconds(400))
                guard !Task.isCancelled else { return }
                await runQuery()
            }
            .task {
                if !search.didLoadHighlights { await search.loadHighlights() }
                await suggest()
            }
            .onChange(of: items.map(\.id)) { _, _ in
                Task { await suggest() }
            }
            .navigationTitle("Spot hinzufügen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Picker("Ansicht", selection: $layout) {
                        Text("Liste").tag(Layout.list.rawValue)
                        Text("Karte").tag(Layout.map.rawValue)
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 160)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fertig") { dismiss() }
                }
            }
            .plannerErrorBanner(search.errorMessage ?? viewModel.errorMessage, dismiss: {
                search.errorMessage = nil
                viewModel.errorMessage = nil
            })
            .sheet(item: $detail) { item in
                NavigationStack {
                    TripSpotDetailView(spot: item.detail, mode: viewModel.leg?.transportMode ?? .foot) { close in
                        TripSpotActionSections(actions: actions(item), close: close)
                    }
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Schließen", systemImage: "xmark") { detail = nil }
                        }
                    }
                }
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                .opaqueSheetBackground()
            }
        }
    }

    // MARK: - Chips

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(TripPickerChip.allCases) { option in
                    Button {
                        chip = option
                        if option != .more { category = nil }
                    } label: {
                        Text(option.label)
                            .font(.subheadline.weight(chip == option ? .semibold : .regular))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(chip == option ? Color.accentColor.opacity(0.18) : Color(.tertiarySystemFill),
                                        in: .capsule)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(chip == option ? .isSelected : [])
                }
                if search.area != nil {
                    Button {
                        search.area = nil
                        Task { await reload() }
                    } label: {
                        Label("Kartenbereich", systemImage: "xmark.circle.fill")
                            .font(.subheadline)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(Color(.tertiarySystemFill), in: .capsule)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Wieder um die Unterkunft suchen")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .background(.bar)
    }

    // MARK: - List

    private var list: some View {
        List {
            if chip == .more && category == nil && search.query.isEmpty {
                Section("Kategorien") {
                    ForEach(TripPlaceCategory.all) { option in
                        Button {
                            category = option
                            Task { await search.search(category: option) }
                        } label: {
                            Label(option.label, systemImage: option.systemImage)
                        }
                    }
                }
            } else {
                if let category, chip == .more {
                    Section {
                        Button("Alle Kategorien", systemImage: "chevron.left") {
                            self.category = nil
                            search.clearCategory()
                        }
                    } header: {
                        Text(category.label)
                    }
                }
                if search.highlightsSorting && chip != .ideas && search.query.isEmpty {
                    Label("Die Highlights werden noch sortiert; bis dahin nach Bekanntheit.",
                          systemImage: "arrow.up.arrow.down")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                ForEach(items) { item in
                    row(item)
                }
                if items.isEmpty {
                    emptyRow
                }
                if chip != .ideas && search.query.isEmpty && search.highlightsHaveMore {
                    Button("Mehr Highlights") { Task { await search.loadHighlights(more: true) } }
                        .disabled(search.isLoadingHighlights)
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    @ViewBuilder
    private var emptyRow: some View {
        if search.isSearching || (search.isLoadingHighlights && search.highlights.isEmpty) {
            HStack { ProgressView(); Text("Wird geladen…") }
        } else if chip == .ideas {
            Text("Noch keine Ideen für diesen Aufenthalt.")
                .foregroundStyle(.secondary)
        } else if search.highlightsUnavailable && search.query.isEmpty {
            Text("Die Umgebungssuche antwortet gerade nicht.")
                .foregroundStyle(.secondary)
        } else {
            Text(search.query.isEmpty ? "Hier ist nichts bekannt." : "Nichts gefunden.")
                .foregroundStyle(.secondary)
        }
    }

    private func row(_ item: TripPickerItem) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Button {
                detail = item
            } label: {
                HStack(alignment: .top, spacing: 10) {
                    if let picture = item.picture {
                        TripSpotThumbnail(image: picture, height: 56, width: 56)
                    } else {
                        Image(systemName: item.isIdea ? "lightbulb" : "mappin")
                            .foregroundStyle(.secondary)
                            .frame(width: 56, height: 56)
                            .background(Color(.tertiarySystemFill), in: .rect(cornerRadius: 8))
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(TripSpotName.line(item.title, local: item.localName))
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(2)
                        if let line = item.line {
                            Text(line)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        HStack(spacing: 6) {
                            if let minutes = item.dwellMinutes {
                                Text(TripClock.duration(minutes))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            if case .idea(let candidate) = item.source {
                                TripIdeaChips(priority: candidate.ideaPriority, ticket: candidate.ticket,
                                              closedOn: candidate.closedOn ?? [],
                                              openingHours: candidate.openingHours)
                            } else if item.isIdea {
                                Text("Idee").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        if let status = done[item.id] {
                            Label(status, systemImage: "checkmark.circle.fill")
                                .font(.caption)
                                .foregroundStyle(.green)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)

            addButton(item)
        }
        .contextMenu {
            TripSpotActionMenuItems(actions: actions(item))
        }
    }

    @ViewBuilder
    private func addButton(_ item: TripPickerItem) -> some View {
        if item.isPlanned || done[item.id]?.hasPrefix("auf Tag") == true {
            Image(systemName: "checkmark")
                .foregroundStyle(.secondary)
                .frame(minWidth: 44, minHeight: 32)
                .accessibilityLabel("Schon eingeplant")
        } else {
            let suggestion = search.suggestions[item.osmRef]
            Button {
                Task { await add(item, onDay: suggestion?.dayIndex) }
            } label: {
                if busy == item.id {
                    ProgressView()
                } else {
                    Text(TripSpotPicker.addLabel(suggestion))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(suggestion?.full == true ? Color.orange : Color.accentColor)
                }
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .disabled(busy != nil)
            .accessibilityHint(suggestion?.full == true
                               ? "Der Tag ist schon voll"
                               : "Lange drücken für einen anderen Tag")
        }
    }

    // MARK: - Food

    private func food(_ leg: TripLeg) -> some View {
        let day = TripSpotPicker.foodDay(leg.days)
        let block = day.flatMap(TripSpotPicker.spotsBlock(of:))
        return TripFoodListView(
            position: leg.anchor,
            target: day.flatMap { day in
                block.map { TripFoodListView.BlockTarget(planId: viewModel.planId, legIndex: leg.position,
                                                         dayIndex: day.dayIndex, blockId: $0.id) }
            },
            onPlaced: { await viewModel.load() },
            planId: viewModel.planId,
        )
    }

    // MARK: - Actions

    /// What can be done with a row: the suggested day, every other day,
    /// keeping it as an idea. One list for the long press and the details.
    private func actions(_ item: TripPickerItem) -> [TripPinSheetAction] {
        guard let leg = viewModel.leg, !item.isPlanned else { return [] }
        let suggested = search.suggestions[item.osmRef]?.dayIndex
        var out: [TripPinSheetAction] = leg.days.sorted { $0.dayIndex < $1.dayIndex }.map { day in
            let title = TripStayPlan.dayTitle(day, leg: leg)
            return TripPinSheetAction(
                id: "day-\(day.dayIndex)",
                title: day.dayIndex == suggested ? "Auf \(title) (vorgeschlagen)" : "Auf \(title)",
                systemImage: day.dayIndex == suggested ? "calendar.badge.plus" : "calendar",
                closes: false,
            ) {
                await add(item, onDay: day.dayIndex)
            }
        }
        if !item.isIdea {
            out.append(TripPinSheetAction(
                id: "keep", title: "Als Idee behalten", systemImage: "lightbulb", closes: false,
            ) {
                await add(item, onDay: nil)
            })
        }
        return out
    }

    /// Puts a place on a day, or only into the ideas when `day` is nil.
    private func add(_ item: TripPickerItem, onDay day: Int?) async {
        guard busy == nil else { return }
        busy = item.id
        defer { busy = nil }
        let ref: String
        switch item.source {
        case .idea(let candidate):
            ref = candidate.osmRef
        case .highlight, .place:
            if item.isIdea {
                ref = item.osmRef
            } else {
                guard let place = item.searched(legIndex: legIndex),
                      let added = await search.addReturningRef(place)
                else { return }
                ref = added
            }
        }
        guard let day else {
            done[item.id] = "bei den Ideen"
            await viewModel.load()
            return
        }
        guard let target = viewModel.leg?.days.first(where: { $0.dayIndex == day }),
              let block = TripSpotPicker.spotsBlock(of: target)
        else { return }
        if await viewModel.place(osmRef: ref, inBlock: block.id, onDay: day) {
            done[item.id] = "auf Tag \(day + 1)"
            search.forgetSuggestions()
            await suggest()
        }
    }

    // MARK: - Loading

    private func runQuery() async {
        let text = search.query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard link == nil else { return }
        if text.count >= 2 {
            await search.search()
        }
    }

    private func reload() async {
        await search.loadHighlights()
        if search.query.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2 {
            await search.search()
        } else if let category {
            await search.search(category: category)
        }
        await suggest()
    }

    private func suggest() async {
        let spots = items.filter { !$0.isPlanned }.map(\.suggestSpot)
        await search.loadSuggestions(for: spots)
    }
}

/// The picker on a map: highlights as circles sized by fame, ideas
/// filled, the stay's planned spots with their day and number. Moving
/// the map searches nothing until "In diesem Bereich suchen".
struct TripSpotPickerMap: View {
    let items: [TripPickerItem]
    let leg: TripLeg?
    let open: (TripPickerItem) -> Void
    let searchHere: (TripSearchArea) -> Void

    @State private var region: MKCoordinateRegion?
    @State private var moved = false

    var body: some View {
        Map(initialPosition: .automatic) {
            if let leg {
                Annotation("Unterkunft", coordinate: CLLocationCoordinate2D(latitude: leg.anchor.lat,
                                                                           longitude: leg.anchor.lon)) {
                    Image(systemName: "bed.double.fill")
                        .font(.caption)
                        .foregroundStyle(.white)
                        .frame(width: 26, height: 26)
                        .background(Color.secondary, in: .circle)
                }
                ForEach(planned(leg), id: \.id) { mark in
                    Annotation(mark.title, coordinate: CLLocationCoordinate2D(mark.coordinate)) {
                        Text(mark.label)
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 5)
                            .frame(minWidth: 26, minHeight: 22)
                            .background(Color.accentColor, in: .capsule)
                    }
                }
            }
            ForEach(items) { item in
                Annotation(item.title, coordinate: CLLocationCoordinate2D(item.coordinate)) {
                    Button {
                        open(item)
                    } label: {
                        marker(item)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(item.title)
                }
            }
        }
        .onMapCameraChange(frequency: .onEnd) { context in
            if region != nil { moved = true }
            region = context.region
        }
        .overlay(alignment: .top) {
            if moved, let region {
                Button {
                    moved = false
                    searchHere(TripSearchArea(
                        lat: region.center.latitude,
                        lon: region.center.longitude,
                        radiusM: TripSpotPicker.radiusM(latitudeDelta: region.span.latitudeDelta,
                                                        longitudeDelta: region.span.longitudeDelta,
                                                        latitude: region.center.latitude),
                    ))
                } label: {
                    Label("In diesem Bereich suchen", systemImage: "magnifyingglass")
                        .font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .padding(.top, 8)
            }
        }
    }

    @ViewBuilder
    private func marker(_ item: TripPickerItem) -> some View {
        if item.isIdea {
            Image(systemName: "lightbulb.fill")
                .font(.caption)
                .foregroundStyle(.white)
                .frame(width: 26, height: 26)
                .background(Color.orange, in: .circle)
        } else {
            let size = CGFloat(TripSpotPicker.markerSize(rank: item.rank))
            Circle()
                .fill(Color.accentColor.opacity(0.25))
                .overlay(Circle().strokeBorder(Color.accentColor, lineWidth: 2))
                .frame(width: size, height: size)
        }
    }

    private struct PlannedMark: Identifiable {
        let id: String
        let title: String
        let label: String
        let coordinate: TripCoordinate
    }

    /// "2·3": the third spot of day two.
    private func planned(_ leg: TripLeg) -> [PlannedMark] {
        leg.days.flatMap { day in
            TripStayPlan.stops(of: day).enumerated().map { index, stop in
                PlannedMark(id: "\(day.dayIndex)-\(stop.id)", title: stop.displayName,
                            label: "\(day.dayIndex + 1)·\(index + 1)", coordinate: stop.coordinate)
            }
        }
    }
}
