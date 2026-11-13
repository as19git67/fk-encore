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
    /// After "Ausflüge": the day out the search is around, and the day
    /// "+ Tag n" adds to.
    @State private var tripFocus: TripDayTripFocus?
    /// What "+" adds to (Mock 17): the stay, an excursion's window or a
    /// day out; nil on a journey, which has no bar "Für".
    @State private var target: TripPickerTarget?
    @State private var choosingTarget = false
    /// The idea a fixed time is being written for (§4.4).
    @State private var appointmentFor: TripCandidate?
    /// What an action in the details queued for when they have closed:
    /// a second sheet cannot open while the first is up.
    @State private var afterDetail: (@MainActor () -> Void)?
    /// The vote over the stay's ideas, when the trip votes.
    @State private var ballot: TripStayBallot
    @AppStorage("trip.spotPicker.layout") private var layout = Layout.list.rawValue
    @Environment(\.dismiss) private var dismiss

    private enum Layout: String { case list, map }

    /// `chip` is where the picker opens: the stay sheet's "Ideen",
    /// "Ausflüge" and "Strecken" open on theirs.
    /// `dayTrip` opens it from a day out: the search goes around where
    /// that day goes, and "+ Tag n" adds to that day.
    /// `excursion` opens it from a time window inside a day (Mock 16):
    /// the search goes around its destination and "+" adds into its window.
    /// `day` opens it from a day at the quarters: "+" puts the spot there.
    init(viewModel: TripPlannerViewModel, chip: TripPickerChip = .all, dayTrip: Int? = nil,
         excursion: (dayIndex: Int, excursion: TripExcursion)? = nil, day: Int? = nil) {
        _viewModel = State(initialValue: viewModel)
        let search = TripPlaceSearchViewModel(
            planId: viewModel.planId, legIndex: viewModel.legIndex, ideas: true)
        var chip = chip
        let leg = viewModel.leg
        var target = leg.flatMap { $0.isTransit ? nil : TripPickerTargets.stay($0) }
        if let excursion {
            let focus = TripSpotPicker.excursionFocus(excursion.excursion, dayIndex: excursion.dayIndex)
            search.area = focus.area
            _tripFocus = State(initialValue: focus.focus)
            if let day = leg?.days.first(where: { $0.dayIndex == excursion.dayIndex }) {
                target = TripPickerTargets.excursion(excursion.excursion, on: day)
            }
            chip = .highlights
        } else if let focus = TripSpotPicker.dayTripFocus(dayTrip, in: leg) {
            search.area = focus.area
            _tripFocus = State(initialValue: focus.focus)
            if let day = leg?.days.first(where: { $0.dayIndex == dayTrip }) {
                target = TripPickerTargets.dayTrip(day)
            }
            chip = .highlights
        } else if let day, let leg, !leg.isTransit, leg.days.contains(where: { $0.dayIndex == day }) {
            let atDay = TripPickerTargets.stay(leg, day: day)
            target = atDay
            _tripFocus = State(initialValue: atDay.focus)
        }
        _target = State(initialValue: target)
        _search = State(initialValue: search)
        _chip = State(initialValue: chip)
        _ballot = State(initialValue: TripStayBallot(planId: viewModel.planId, legIndex: viewModel.legIndex))
    }

    private var votes: Bool { viewModel.plan?.isVoting == true }

    /// Anything the picker waits for that no row or list shows itself.
    private var working: Bool {
        viewModel.isWorking || ballot.isLoading
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
            content
                .safeAreaInset(edge: .top, spacing: 0) {
                    VStack(spacing: 0) {
                        if let current = liveTarget { targetBar(current) }
                        chips
                    }
                    .background(.bar)
                }
                .searchable(text: $search.query, placement: .navigationBarDrawer(displayMode: .always),
                            prompt: liveTarget?.searchPrompt ?? "Name, Kategorie oder Karten-Link")
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
                .task(id: votes) { if votes { await ballot.load() } }
                .onChange(of: items.map(\.id)) { _, _ in
                    Task { await suggest() }
                }
                .navigationTitle(viewModel.leg.map { $0.isTransit ? "Halte unterwegs" : "Spots für \($0.displayTitle)" } ?? "Spots")
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
                    .ownBackground()
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Fertig") { dismiss() }
                    }
                    // The plan, the votes or a change on their way: a
                    // sign, so nothing changes on screen without warning.
                    if working {
                        ToolbarItem(placement: .topBarLeading) {
                            ProgressView()
                                .accessibilityLabel("Wird geladen")
                        }
                    }
                }
                .plannerErrorBanner(errorText, dismiss: {
                    search.errorMessage = nil
                    viewModel.errorMessage = nil
                    ballot.errorMessage = nil
                })
                .sheet(item: $appointmentFor) { appointmentSheet($0) }
                .sheet(isPresented: $choosingTarget) { targetChooser }
                .sheet(item: $detail, onDismiss: runAfterDetail) { detailSheet($0) }
        }
    }

    /// What the chip shows.
    @ViewBuilder
    private var content: some View {
        if chip == .food, let leg = viewModel.leg {
            food(leg)
        } else if chip == .routes, let leg = viewModel.leg {
            TripStayRoutesList(viewModel: viewModel, leg: leg, showsMap: layout == Layout.map.rawValue)
        } else if chip == .trips, let leg = viewModel.leg {
            TripStayDayTripsList(planId: viewModel.planId, leg: leg,
                                 showsMap: layout == Layout.map.rawValue) { focus, area in
                await viewModel.load()
                tripFocus = focus
                search.area = area
                target = viewModel.leg.flatMap { leg in
                    TripPickerTargets.away(of: leg).first { $0.kind == .dayTrip && $0.dayIndex == focus.dayIndex }
                } ?? target
                chip = .highlights
                search.forgetSuggestions()
                await reload()
            }
        } else if layout == Layout.map.rawValue {
            TripSpotPickerMap(
                items: items,
                leg: viewModel.leg,
                open: { detail = $0 },
                searchHere: { area in
                    // "In diesem Bereich suchen" stays with the excursion (Mock 17).
                    search.area = area
                    Task { await reload() }
                },
                loading: search.isSearching || search.isLoadingHighlights,
            )
        } else {
            list
        }
    }

    private var errorText: String? {
        search.errorMessage ?? viewModel.errorMessage ?? ballot.errorMessage
    }

    @ViewBuilder
    private func appointmentSheet(_ candidate: TripCandidate) -> some View {
        if let leg = viewModel.leg {
            TripFixpointSheet(
                dayLabel: "Termin",
                spots: leg.spotChoices,
                presetSpot: TripSpotChoice(osmRef: candidate.osmRef, name: candidate.displayName,
                                           plannedOn: nil),
                days: leg.days.sorted { $0.dayIndex < $1.dayIndex }.map { day in
                    TripDayChoice(dayIndex: day.dayIndex, label: TripStayPlan.dayTitle(day, leg: leg))
                },
                presetDayIndex: tripFocus?.dayIndex ?? search.suggestions[candidate.osmRef]?.dayIndex,
            ) { draft in
                await appoint(candidate, draft)
            }
        }
    }

    @ViewBuilder
    private func detailSheet(_ item: TripPickerItem) -> some View {
        NavigationStack {
            TripSpotDetailView(spot: pickerDetail(item), mode: viewModel.leg?.transportMode ?? .foot,
                               onCategory: item.isIdea || item.isPlanned
                                   ? { await viewModel.setCategory(osmRef: item.osmRef, $0) } : nil,
                               stayLight: TripStayLightRef(planId: viewModel.planId, legIndex: viewModel.legIndex,
                                                           osmRef: item.detail.osmRef,
                                                           startDate: viewModel.leg?.startDate),
                               onStayLightAccepted: { await viewModel.load() },
                               bar: detailBar(item)) { _ in EmptyView() }
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
                if search.area != nil && search.area != liveTarget?.area {
                    Button {
                        search.area = liveTarget?.area
                        Task { await reload() }
                    } label: {
                        Label("Kartenbereich", systemImage: "xmark.circle.fill")
                            .font(.subheadline)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(Color(.tertiarySystemFill), in: .capsule)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(liveTarget?.kind == .stay || liveTarget == nil
                                        ? "Wieder um die Unterkunft suchen"
                                        : "Wieder um \(liveTarget!.name) suchen")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
    }

    // MARK: - List

    private var list: some View {
        List {
            if let kept = viewModel.keptForNextTime {
                Text(kept).font(.footnote).foregroundStyle(.secondary)
            }
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
                    Label("Das lokale Modell ordnet die Highlights noch; bis dahin stehen sie nach Bekanntheit.",
                          systemImage: "arrow.up.arrow.down")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                let all = items
                let ideas = all.filter(\.isOwnIdea)
                let found = all.filter { !$0.isOwnIdea }
                // A list already on screen is being replaced (another
                // target, area or query): say so above it, rather than
                // let new rows appear later without warning.
                if !all.isEmpty && chip != .ideas && (search.isSearching || search.isLoadingHighlights) {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text(search.isSearching ? "Suche läuft…" : "Wird geladen…")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                if let away = liveTarget, away.kind != .stay {
                    awaySections(away, ideas: ideas, found: found)
                } else {
                    staySections(ideas: ideas, found: found)
                }
                if all.isEmpty {
                    emptyRow
                }
                if chip != .ideas && search.query.isEmpty && search.highlightsHaveMore {
                    Button {
                        Task { await search.loadHighlights(more: true) }
                    } label: {
                        HStack(spacing: 8) {
                            Text("Mehr Highlights")
                            if search.isLoadingHighlights && !search.highlights.isEmpty {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(search.isLoadingHighlights)
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    /// The stay's list: its ideas, then the highlights or what was found.
    @ViewBuilder
    private func staySections(ideas: [TripPickerItem], found: [TripPickerItem]) -> some View {
        if !ideas.isEmpty {
            Section {
                ForEach(ideas) { item in row(item) }
            } header: {
                Text(ideas.count == 1 ? "Eure Ideen · 1 noch ohne Tag"
                                      : "Eure Ideen · \(ideas.count) noch ohne Tag")
            }
        }
        if !found.isEmpty {
            Section {
                ForEach(found) { item in row(item) }
            } header: {
                Text(search.query.isEmpty && chip != .more
                     ? "Highlights in der Nähe · nach Bekanntheit" : "Treffer")
            }
        }
    }

    /// Mock 17, A: what is around the destination, then the ideas near
    /// it, then the rest of the stay's ideas.
    @ViewBuilder
    private func awaySections(_ away: TripPickerTarget, ideas: [TripPickerItem], found: [TripPickerItem]) -> some View {
        if !found.isEmpty {
            Section {
                ForEach(found) { item in row(item) }
            } header: {
                Text(search.query.isEmpty && chip != .more ? "Um \(away.name)" : "Treffer")
            }
        }
        let split = TripPickerTargets.splitIdeas(ideas, around: away)
        if !split.near.isEmpty {
            Section("Aus euren Ideen, nahe \(away.name)") {
                ForEach(split.near) { item in row(item) }
            }
        }
        if !split.rest.isEmpty {
            Section("Weitere Ideen des Aufenthalts") {
                ForEach(split.rest) { item in row(item) }
            }
        }
    }

    // MARK: - For

    /// The target as the plan has it now: what its window still holds
    /// changes with every spot added.
    private var liveTarget: TripPickerTarget? {
        guard let target else { return nil }
        return TripPickerTargets.refreshed(target, in: viewModel.leg) ?? target
    }

    /// The bar "Für" over the search (Mock 17): what "+" adds to, and
    /// "Ändern" for the stay, its excursions and its days out.
    private func targetBar(_ current: TripPickerTarget) -> some View {
        let away = current.kind != .stay
        return VStack(alignment: .leading, spacing: 4) {
            Text("FÜR")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Button {
                choosingTarget = true
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Label(current.title, systemImage: away ? "car.fill" : "bed.double")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)
                        Text(current.barLine)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Text("Ändern")
                        .font(.subheadline)
                        .foregroundStyle(Color.accentColor)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(away ? Color.accentColor.opacity(0.12) : Color(.tertiarySystemFill),
                            in: .rect(cornerRadius: 10))
                .overlay {
                    if away {
                        RoundedRectangle(cornerRadius: 10).strokeBorder(Color.accentColor, lineWidth: 1)
                    }
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Für: \(current.title), \(current.barLine)")
            .accessibilityHint("Wählen, wofür gesucht wird")
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }

    /// Mock 17, B: the stay, then each day with an excursion or a day out.
    private var targetChooser: some View {
        NavigationStack {
            List {
                if let leg = viewModel.leg {
                    Section {
                        targetRow(TripPickerTargets.stay(leg))
                    }
                    ForEach(TripPickerTargets.days(of: leg)) { day in
                        Section(day.title) {
                            ForEach(day.targets) { targetRow($0) }
                        }
                    }
                    Section {
                    } footer: {
                        Text("Nur Ausflüge stehen hier; ein Tag ohne steckt in „\(leg.displayTitle)“.")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Wofür suchen?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { choosingTarget = false }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .opaqueSheetBackground()
    }

    private func targetRow(_ option: TripPickerTarget) -> some View {
        let chosen = option.id == liveTarget?.id
        return Button {
            choose(option)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "checkmark")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                    .opacity(chosen ? 1 : 0)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Label(option.title, systemImage: option.kind == .stay ? "bed.double" : "car.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text(option.line)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }

    /// Search around the new target, and add there.
    private func choose(_ option: TripPickerTarget) {
        choosingTarget = false
        guard option.id != liveTarget?.id else { return }
        target = option
        tripFocus = option.focus
        search.area = option.area
        if option.kind != .stay && chip == .all { chip = .highlights }
        search.forgetSuggestions()
        Task { await reload() }
    }

    /// The excursion or day out a row lies at, while the picker adds to
    /// the stay: its "+" then goes there (Mock 17, B).
    private func nearTarget(_ item: TripPickerItem) -> TripPickerTarget? {
        guard liveTarget?.kind == .stay, liveTarget?.dayIndex == nil, let leg = viewModel.leg else { return nil }
        return TripPickerTargets.near(item.coordinate, in: TripPickerTargets.away(of: leg))
    }

    /// Where "+" on a row puts the spot: the chosen excursion, or the one
    /// the row lies at.
    private func rowFocus(_ item: TripPickerItem) -> TripDayTripFocus? {
        tripFocus ?? nearTarget(item)?.focus
    }

    /// True when a row takes longer than the excursion's window holds.
    private func misfits(_ item: TripPickerItem) -> Bool {
        guard let away = liveTarget, away.kind == .excursion else { return false }
        return TripPickerTargets.doesNotFit(dwellMinutes: item.dwellMinutes, away)
    }

    @ViewBuilder
    private var emptyRow: some View {
        if chip == .ideas && viewModel.isLoading {
            HStack { ProgressView(); Text("Ideen werden geladen…") }
        } else if chip != .ideas
                    && (search.isSearching || (search.isLoadingHighlights && search.highlights.isEmpty)) {
            HStack { ProgressView(); Text(search.isSearching ? "Suche läuft…" : "Wird geladen…") }
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
                    // The same 44 pt square as the rows of Ausflüge and
                    // Strecken (Anton, 10.11.).
                    if let picture = item.picture {
                        TripSpotThumbnail(image: picture, height: 44, width: 44)
                    } else if search.picturesPending, case .highlight = item.source {
                        // The server is still looking for its picture.
                        ProgressView()
                            .controlSize(.small)
                            .frame(width: 44, height: 44)
                            .background(Color(.tertiarySystemFill), in: .rect(cornerRadius: 8))
                            .accessibilityHidden(true)
                    } else {
                        Image(systemName: item.isIdea ? "lightbulb" : "mappin")
                            .foregroundStyle(.secondary)
                            .frame(width: 44, height: 44)
                            .background(Color(.tertiarySystemFill), in: .rect(cornerRadius: 8))
                            .accessibilityHidden(true)
                    }
                    rowText(item)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)

            if let entry = voteEntry(item) {
                TripVoteRing(ballot: ballot, entry: entry)
            }
            addButton(item)
        }
        // Longer than the window holds: pale, but "+" still adds it.
        .opacity(misfits(item) ? 0.55 : 1)
        .contextMenu {
            TripSpotActionMenuItems(actions: actions(item))
        }
    }

    private func rowText(_ item: TripPickerItem) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(TripSpotName.line(item.title, local: item.localName))
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)
            if let summary = item.summary {
                Text(summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if let line = item.line {
                Text(line)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if let place = placeLine(item) {
                Text(place)
                    .font(.caption)
                    .foregroundStyle(.secondary)
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
            // Who said what, in names rather than a number (§6.1).
            if let voices = voteEntry(item)?.voices {
                Text(voices).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    /// Where a row lies from the chosen excursion ("600 m vom Ziel",
    /// "passt nicht, 1 h 20 frei"), or the excursion it lies at while
    /// the picker adds to the stay ("nahe Seestadt · Ausflug Tag 3").
    private func placeLine(_ item: TripPickerItem) -> String? {
        guard !item.isPlanned else { return nil }
        if let away = liveTarget, away.kind != .stay {
            let distance = TripPickerTargets.fromDestination(item.coordinate, away)
            if misfits(item) {
                return [distance, TripPickerTargets.misfitText(away)].compactMap { $0 }.joined(separator: " · ")
            }
            return distance
        }
        return nearTarget(item).map(TripPickerTargets.nearText)
    }

    @ViewBuilder
    private func addButton(_ item: TripPickerItem) -> some View {
        if item.isPlanned || done[item.id]?.hasPrefix("auf Tag") == true {
            let day = plannedDay(item.osmRef)
            Label(day.map { "Tag \($0 + 1)" } ?? "eingeplant", systemImage: "checkmark")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(minWidth: 44, minHeight: 32)
                .accessibilityLabel(day.map { "Schon eingeplant, Tag \($0 + 1)" } ?? "Schon eingeplant")
        } else {
            let suggestion = search.suggestions[item.osmRef]
            let focus = rowFocus(item)
            let into = liveTarget?.kind == .stay && liveTarget?.dayIndex == nil ? nearTarget(item) : liveTarget
            TripAddButton(running: busy == item.id,
                          waiting: focus == nil && search.isSuggesting(item.osmRef),
                          full: focus == nil && suggestion?.full == true,
                          label: focus != nil ? (into?.addLabel ?? "Hinzufügen")
                              : TripSpotPicker.addLabel(suggestion, onTheWay: viewModel.leg?.isTransit == true)) {
                Task { await add(item, onDay: focus?.dayIndex ?? suggestion?.dayIndex, into: focus) }
            }
            .disabled(busy != nil)
        }
    }

    /// The day a place is planned on in this stay, for "✓ Tag 1".
    private func plannedDay(_ osmRef: String) -> Int? {
        viewModel.leg?.days.first { day in
            TripStayPlan.stops(of: day).contains { $0.osmRef == osmRef }
        }?.dayIndex
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

    /// The vote on an idea, when the trip votes.
    private func voteEntry(_ item: TripPickerItem) -> TripBallotEntry? {
        guard votes, item.isIdea else { return nil }
        return ballot.entry(item.osmRef)
    }

    /// What can be done with a row: the suggested day, every other day,
    /// keeping it as an idea; for an idea also a fixed time, how much it
    /// matters, the vote and taking it out. One list for the long press
    /// and the details (CLAUDE.md, "Aktionen an Spots in der iOS-App").
    ///
    /// `later` runs what opens a sheet of its own once the details have
    /// closed.
    private func actions(
        _ item: TripPickerItem,
        later: @escaping @MainActor (@escaping @MainActor () -> Void) -> Void = { $0() },
    ) -> [TripPinSheetAction] {
        guard let leg = viewModel.leg, !item.isPlanned else { return [] }
        let focus = rowFocus(item)
        let suggested = focus == nil ? search.suggestions[item.osmRef]?.dayIndex : nil
        // Every excursion of the stay, the one "+" adds to first (Mock 17:
        // a long press offers another excursion, another day, or the idea).
        let windows = TripPickerTargets.away(of: leg).filter { $0.kind == .excursion }
        let isFocus = { (option: TripPickerTarget) in focus?.blockId != nil && option.blockId == focus?.blockId }
        let excursions = windows.filter(isFocus) + windows.filter { !isFocus($0) }
        var out: [TripPinSheetAction] = excursions.map { option in
            TripPinSheetAction(
                id: "target-\(option.id)",
                title: "\(option.title) · Tag \((option.dayIndex ?? 0) + 1)",
                systemImage: "car",
                closes: false,
                submenu: .days,
            ) {
                await add(item, onDay: option.dayIndex, into: option.focus)
            }
        }
        // A day out as a whole puts the spot on that day; every other day
        // takes it at the quarters.
        out += leg.days.sorted { $0.dayIndex < $1.dayIndex }.map { day -> TripPinSheetAction in
            let title = TripStayPlan.dayTitle(day, leg: leg)
            let dayOut = day.anchor != nil
            let chosen = day.dayIndex == suggested || (focus?.blockId == nil && focus?.dayIndex == day.dayIndex)
            return TripPinSheetAction(
                id: "day-\(day.dayIndex)",
                title: chosen ? "\(title) · Vorschlag" : title,
                systemImage: chosen ? "calendar.badge.plus" : "calendar",
                closes: false,
                submenu: .days,
            ) {
                await add(item, onDay: day.dayIndex,
                          into: dayOut ? TripPickerTargets.dayTrip(day)?.focus : nil)
            }
        }
        if !item.isIdea {
            out.append(TripPinSheetAction(
                id: "keep", title: "Als Idee behalten", systemImage: "lightbulb", closes: false,
            ) {
                await add(item, onDay: nil)
            })
        }
        if case .idea(let candidate) = item.source {
            // A ticket for it (§4.4): the idea goes to that day at that
            // hour, and the order keeps it there.
            out.append(TripPinSheetAction(id: "appointment", title: "Feste Zeit …",
                                          systemImage: "calendar.badge.clock") {
                later { appointmentFor = candidate }
            })
            out.append(TripPinSheetAction(id: "keep", title: "Für andere Reisen merken", systemImage: "lightbulb",
                                          footer: "Eine Kopie in den Ideenvorrat für eine andere Reise.",
                                          closes: false) {
                await viewModel.keepForNextTime(osmRefs: [candidate.osmRef])
            })
            out.append(contentsOf: TripIdeaPriority.actions(current: candidate.ideaPriority) { priority in
                await viewModel.setPriority(osmRef: candidate.osmRef, priority)
            })
            if let entry = voteEntry(item) {
                out.append(contentsOf: ballot.actions(entry))
            }
            out.append(TripPinSheetAction(
                id: "drop",
                title: "Aus den Ideen entfernen",
                systemImage: "trash",
                role: .destructive,
                group: .remove,
            ) {
                await viewModel.drop(candidate)
            })
        }
        return out
    }

    /// The details with how far the place is from the bed.
    private func pickerDetail(_ item: TripPickerItem) -> TripSpotDetail {
        var detail = item.detail
        if let leg = viewModel.leg { detail.distance = TripSpotDetailContext.distance(to: detail.coordinate, in: leg) }
        return detail
    }

    /// The details' bar: "+" (Hinzufügen) for the suggested day next to Route
    /// and Karte, the other days and the rest under "Mehr" (mock
    /// "Spot-Auswahl und Spot-Details").
    private func detailBar(_ item: TripPickerItem) -> TripSpotDetailBar {
        let all = actions(item, later: { afterDetail = $0 })
        let focus = rowFocus(item)
        let suggested = focus?.dayIndex ?? search.suggestions[item.osmRef]?.dayIndex
            ?? viewModel.leg?.days.map(\.dayIndex).min()
        let primary = focus?.blockId.flatMap { id in all.first { $0.id == "target-\(id)" } }
            ?? all.first { $0.id == "day-\(suggested ?? -1)" }
        return TripSpotDetailBar(primary: primary,
                                 primaryTitle: suggested.map { _ in "Hinzufügen" },
                                 primaryImage: "plus.circle",
                                 more: all.filter { $0.id != primary?.id })
    }

    private func runAfterDetail() {
        let work = afterDetail
        afterDetail = nil
        work?()
    }

    /// A fixed time for an idea: on its day first, then the time. The
    /// time alone would hold a spot that is still only an idea, and the
    /// day would not show it.
    private func appoint(_ candidate: TripCandidate, _ draft: TripFixpointSheet.Draft) async {
        if let day = draft.dayIndex,
           let target = viewModel.leg?.days.first(where: { $0.dayIndex == day }),
           let block = TripSpotPicker.spotsBlock(of: target) {
            guard await viewModel.place(osmRef: candidate.osmRef, inBlock: block.id, onDay: day) else { return }
            done[candidate.osmRef] = "auf Tag \(day + 1)"
        }
        await viewModel.addFixpoint(draft, legIndex: legIndex)
    }

    /// Puts a place on a day, or only into the ideas when `day` is nil.
    /// `into` names the excursion's window on that day; without it the
    /// spot goes to the day at the quarters.
    private func add(_ item: TripPickerItem, onDay day: Int?, into focus: TripDayTripFocus? = nil) async {
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
              let block = TripSpotPicker.block(of: target, focus: focus)
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

/// The standard "+" at the end of a row: it puts the place on the
/// suggested day, which only VoiceOver names (Anton, 10.11.: the day
/// does not matter there). Orange when that day is already full; a
/// long press on the row picks another.
struct TripAddButton: View {
    let running: Bool
    /// The day "+" would add to is still being asked for: the button
    /// waits, rather than put the place only among the ideas.
    var waiting = false
    let full: Bool
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            if running || waiting {
                ProgressView()
            } else {
                Image(systemName: "plus.circle.fill")
                    .font(.title2)
                    .foregroundStyle(full ? Color.orange : Color.accentColor)
            }
        }
        .buttonStyle(.borderless)
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(.rect)
        .disabled(waiting)
        .accessibilityLabel(waiting ? "Tag wird gesucht" : label)
        .accessibilityHint(full ? "Der Tag ist schon voll. Lange drücken für einen anderen Tag"
                                : "Lange drücken für einen anderen Tag")
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
    /// A search or the highlights on their way: the map says so, as the
    /// list does above its rows.
    var loading = false

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
        .overlay(alignment: .bottom) {
            if loading {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Suche läuft…")
                        .font(.subheadline)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(.regularMaterial, in: .capsule)
                .padding(.bottom, 16)
                .accessibilityElement(children: .combine)
            }
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
