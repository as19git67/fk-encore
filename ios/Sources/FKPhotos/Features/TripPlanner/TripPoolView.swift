import SwiftUI

/// The pool — everything this leg could do, and why (§5).
///
/// It was data from the planner's first day and visible nowhere; then
/// it became a list you could look at and nothing else. That was the
/// wrong half to stop at: with four ways in (§9.2) a pile that only
/// grows is not a pool, it is a backlog. Three things were missing and
/// each of them is a gesture somebody reaches for immediately —
/// *where is that*, *not this one*, and *put it in Tuesday morning*.
///
/// The placement deliberately goes through a picker rather than a drag.
/// Dragging out of one screen into a day that is not on screen is not a
/// gesture iOS has; a picker also says out loud which day and which
/// block, which is the part that has consequences for the budget.
struct TripPoolView: View {
    @State var viewModel: TripPlannerViewModel
    /// Which leg's pool. Held as a position rather than as the leg so
    /// the list follows the plan after a placement rewrites it.
    let legIndex: Int
    /// Opened from a block, to fill that block: a tap on a candidate
    /// then places it there and comes back, without the picker asking
    /// a question whose answer was the button you came from.
    var placeInto: TripPoolTarget? = nil

    @State private var query = ""
    @State private var placing: TripCandidate?
    /// A candidate whose pin was tapped on the map.
    @State private var inspecting: TripCandidate?
    /// Set while the pin sheet is still on screen and the traveller has
    /// asked for the block picker. Two sheets cannot take the stage at
    /// once, so the picker waits for the first one to leave.
    @State private var queuedPlacement: TripCandidate?
    /// List or map, remembered. Somebody who thinks in places thinks in
    /// places tomorrow too, and re-tapping the switch on every leg is a
    /// preference the app could simply have kept.
    @AppStorage("trip.pool.presentation") private var presentation = TripPoolPresentation.list
    @Environment(\.dismiss) private var dismiss

    private var leg: TripLeg? {
        viewModel.plan?.legs.first { $0.position == legIndex }
    }

    var body: some View {
        Group {
            switch presentation {
            case .list: list
            case .map:  map
            }
        }
        .navigationTitle(placeInto == nil ? "Kandidaten" : "Stopp hinzufügen")
        .plannerErrorBanner(viewModel.errorMessage, dismiss: { viewModel.errorMessage = nil })
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                // Two shapes of one pool (§5.2): the list answers "what
                // did the planner find", the map "where is all this" —
                // and the second question is the one you ask before
                // deciding what fits into an afternoon (§3.1).
                Picker("Darstellung", selection: $presentation) {
                    ForEach(TripPoolPresentation.allCases, id: \.self) { option in
                        Label(option.label, systemImage: option.symbolName)
                            .labelStyle(.iconOnly)
                            .tag(option)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            ToolbarItem(placement: .topBarTrailing) {
                // The anti-pool: what this trip has turned down. It
                // belongs next to the pool rather than in the settings,
                // because it is the same question — what may the
                // planner offer? — with the opposite answer.
                NavigationLink {
                    TripHiddenSpotsView(viewModel: viewModel)
                } label: {
                    Label("Ausgeblendet", systemImage: "eye.slash")
                }
            }
        }
        .task { await viewModel.loadHiddenSpots() }
        // A pool of a hundred and fifty candidates is what the planner
        // routinely produces; scrolling it to find the one somebody
        // mentioned at breakfast is not a plan. Always on the screen
        // rather than hidden above the first row: a search field you
        // have to know about to pull down is a search field most people
        // never find (§5.2).
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always),
                    prompt: "Kandidaten durchsuchen")
        .sheet(item: $inspecting, onDismiss: startQueuedPlacement) { candidate in
            if let leg {
                TripPinDetailSheet(
                    detail: TripPinDetail.of(candidate),
                    actions: pinActions(candidate),
                    spot: TripSpotDetail(candidate),
                    mode: leg.transportMode,
                )
            }
        }
        .sheet(item: $placing) { candidate in
            NavigationStack {
                TripBlockPickerView(title: candidate.displayName, leg: leg) { blockId, dayIndex in
                    await viewModel.place(candidate, inBlock: blockId, onDay: dayIndex)
                }
            }
        }
        .task { if viewModel.plan == nil { await viewModel.load() } }
    }

    // MARK: - The pool as a list

    private var list: some View {
        List {
            if let kept = viewModel.keptForNextTime {
                Text(kept).font(.footnote).foregroundStyle(.secondary)
            }
            if let placeInto {
                Section {
                    Label("Für \(placeInto.label), Tag \(placeInto.dayIndex + 1) — „Einplanen“ setzt den Ort dorthin.",
                          systemImage: "calendar.badge.plus")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            if let leg {
                if leg.pool.isEmpty {
                    ContentUnavailableView(
                        "Noch keine Kandidaten",
                        systemImage: "tray",
                        description: Text("Was der Planer findet und was ihr selbst beisteuert, "
                                          + "sammelt sich hier."),
                    )
                } else if matches(in: leg).isEmpty {
                    ContentUnavailableView.search(text: query)
                } else {
                    Section {
                        ForEach(matches(in: leg)) { candidate in
                            row(candidate, leg: leg)
                        }
                    } header: {
                        Text(countLabel(leg))
                    } footer: {
                        Text("Der Planer wählt aus den Kandidaten, was in einen Block passt. "
                             + "Was hier liegt, ist nicht verplant — es steht bereit.")
                    }
                }
            } else {
                ContentUnavailableView("Stadt nicht gefunden", systemImage: "tray")
            }
        }
    }

    // MARK: - The pool as a map

    /// The same pool, as places (§5.2).
    ///
    /// No numbers on the pins, because the pool has no order, and no
    /// slider underneath, because it has no hours either: a control that
    /// answers "where would I be at three" over a list of things nobody
    /// has put on a day would be a control that is not operated.
    @ViewBuilder
    private var map: some View {
        if let leg {
            if leg.pool.isEmpty {
                ContentUnavailableView(
                    "Noch keine Kandidaten",
                    systemImage: "map",
                    description: Text("Was der Planer findet und was ihr selbst beisteuert, "
                                      + "sammelt sich hier."),
                )
            } else {
                pins(of: leg)
            }
        } else {
            ContentUnavailableView("Stadt nicht gefunden", systemImage: "map")
        }
    }

    private func pins(of leg: TripLeg) -> some View {
        let shown = matches(in: leg)
        return VStack(spacing: 0) {
            TripSpotMapView(
                anchor: leg.anchor,
                anchorTitle: leg.anchorTitle,
                pins: shown.map { pin($0, leg: leg) },
                showsUserLocation: leg.schedule(on: Date()).isRunning
            ) { picked in
                inspecting = shown.first { $0.osmRef == picked.id }
            }
            legend(shown: shown.count, of: leg.pool.count)
        }
        // The map runs to the bottom edge; the tab bar would steal that
        // row for tabs no map leads to.
        .toolbar(.hidden, for: .tabBar)
        .toolbarBackgroundVisibility(.hidden, for: .tabBar)
        // A search that matches nothing has to say so here too — an
        // empty map reads as a leg without candidates.
        .overlay {
            if shown.isEmpty {
                ContentUnavailableView.search(text: query)
                    .background(.background)
            }
        }
    }

    private func pin(_ candidate: TripCandidate, leg: TripLeg) -> TripSpotMapPin {
        let kind = TripPoolPinKind.of(candidate, plannedRefs: plannedRefs(leg))
        return TripSpotMapPin(
            id: candidate.osmRef,
            coordinate: candidate.coordinate,
            title: candidate.displayName,
            symbolName: kind.symbolName,
            tint: kind.colour,
        )
    }

    /// What the colours mean, and how much of the pool is on screen.
    ///
    /// Always shown rather than behind a button as on the day map: four
    /// kinds are one more than three, and the pool map is the first map
    /// in the app whose colours are not a status somebody just set.
    private func legend(shown: Int, of total: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(TripPoolFilter.countLabel(shown: shown, of: total))
                .font(.caption.weight(.semibold))
            LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading),
                                GridItem(.flexible(), alignment: .leading)],
                      alignment: .leading, spacing: 4) {
                ForEach(TripPoolPinKind.legendOrder, id: \.self) { kind in
                    HStack(spacing: 5) {
                        Circle()
                            .fill(kind.colour)
                            .frame(width: 10, height: 10)
                            .overlay(Circle().stroke(.white, lineWidth: 1))
                        Text(kind.label)
                    }
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(Color(uiColor: .systemBackground).ignoresSafeArea(edges: .bottom))
    }

    /// What a tapped pin can do — the pool's own two gestures (§5.2),
    /// handed to the sheet, which knows the spot and nothing about the
    /// trip.
    private func pinActions(_ candidate: TripCandidate) -> [TripPinSheetAction] {
        var actions: [TripPinSheetAction] = [
            TripPinSheetAction(
                id: "place",
                title: placeInto == nil ? "In einen Block setzen" : "Hier einplanen",
                systemImage: "calendar.badge.plus",
                footer: placeInto.map {
                    "Für \($0.label), Tag \($0.dayIndex + 1)."
                },
                run: {
                    guard let placeInto else {
                        // The picker cannot open while this sheet
                        // is still on screen; it goes up as this one
                        // comes down.
                        queuedPlacement = candidate
                        return
                    }
                    if await viewModel.place(candidate, inBlock: placeInto.blockId,
                                             onDay: placeInto.dayIndex) {
                        dismiss()
                    }
                },
            ),
        ]
        if candidate.isManual {
            // A find somebody brought in themselves is theirs to
            // delete: it exists because a person added it, and nothing
            // will propose it again.
            actions.append(TripPinSheetAction(
                id: "drop",
                title: "Aus den Kandidaten entfernen",
                systemImage: "trash",
                role: .destructive,
                footer: "Selbst hinzugefügt — entfernen heißt hier wirklich weg.",
                run: { await viewModel.drop(candidate) },
            ))
        } else {
            actions.append(TripPinSheetAction(
                id: "hide",
                title: "Für diese Reise ausblenden",
                systemImage: "eye.slash",
                role: .destructive,
                footer: "Der Planer schlägt ihn auf dieser Reise nicht mehr vor, auch beim "
                    + "nächsten Neuplanen nicht. Rückgängig oben unter „Ausgeblendet“.",
                run: { await viewModel.hide(osmRef: candidate.osmRef) },
            ))
        }
        return actions
    }

    /// The block picker the pin sheet asked for, once it has left.
    private func startQueuedPlacement() {
        guard let queued = queuedPlacement else { return }
        queuedPlacement = nil
        placing = queued
    }

    /// Into the block this screen was opened for, or ask which one.
    /// Returns to the day once the stop is placed — that is where the
    /// traveller was, and where the stop now is.
    private func placeOrPick(_ candidate: TripCandidate, then close: (() -> Void)?) async {
        guard let placeInto else {
            placing = candidate
            return
        }
        if await viewModel.place(candidate, inBlock: placeInto.blockId, onDay: placeInto.dayIndex) {
            close?()
            dismiss()
        }
    }

    /// The pool as list and map both show it (§5.2) — one filter, so
    /// what leaves the list leaves the map.
    private func matches(in leg: TripLeg) -> [TripCandidate] {
        TripPoolFilter.matches(in: leg.pool, query: query)
    }

    private func countLabel(_ leg: TripLeg) -> String {
        TripPoolFilter.countLabel(shown: matches(in: leg).count, of: leg.pool.count)
    }

    private func plannedRefs(_ leg: TripLeg) -> Set<String> {
        TripPoolFilter.plannedRefs(of: leg)
    }

    @ViewBuilder
    private func row(_ candidate: TripCandidate, leg: TripLeg) -> some View {
        NavigationLink {
            TripSpotDetailView(
                spot: TripSpotDetail(candidate),
                mode: leg.transportMode,
                onSave: { await viewModel.saveNote($0) },
            ) { closeDetail in
                Section {
                    Button {
                        Task { await placeOrPick(candidate, then: closeDetail) }
                    } label: {
                        Label(placeInto == nil ? "In einen Block setzen" : "Hier einplanen",
                              systemImage: "calendar.badge.plus")
                    }
                    // The same thing the leading swipe does, where it
                    // can be seen (§20.3).
                    Button {
                        Task { await viewModel.keepForNextTime(osmRefs: [candidate.osmRef]) }
                    } label: {
                        Label("Für später merken", systemImage: "lightbulb")
                    }
                    if candidate.isManual {
                        // A find somebody brought in themselves is
                        // theirs to delete: it exists because a person
                        // added it, and nothing will propose it again.
                        Button(role: .destructive) {
                            Task {
                                await viewModel.drop(candidate)
                                closeDetail()
                            }
                        } label: {
                            Label("Aus den Kandidaten entfernen", systemImage: "trash")
                        }
                    } else {
                        Button(role: .destructive) {
                            Task {
                                await viewModel.hide(osmRef: candidate.osmRef)
                                closeDetail()
                            }
                        } label: {
                            Label("Für diese Reise ausblenden", systemImage: "eye.slash")
                        }
                    }
                } footer: {
                    Text(candidate.isManual
                         ? "Selbst hinzugefügt — entfernen heißt hier wirklich weg."
                         : "Ausblenden heißt „diesen nicht“: Der Planer schlägt ihn auf dieser "
                           + "Reise nicht mehr vor, auch beim nächsten Neuplanen nicht. "
                           + "Rückgängig oben unter „Ausgeblendet“.")
                }
            }
        } label: {
            HStack {
                label(candidate, leg: leg)
                if placeInto != nil {
                    Button("Einplanen") {
                        Task { await placeOrPick(candidate, then: nil) }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
        }
        .swipeActions(edge: .trailing) {
            if candidate.isManual {
                Button(role: .destructive) {
                    Task { await viewModel.drop(candidate) }
                } label: {
                    Label("Entfernen", systemImage: "trash")
                }
            } else {
                Button(role: .destructive) {
                    Task { await viewModel.hide(osmRef: candidate.osmRef) }
                } label: {
                    Label("Ausblenden", systemImage: "eye.slash")
                }
            }
        }
        .swipeActions(edge: .leading) {
            Button {
                Task { await placeOrPick(candidate, then: nil) }
            } label: {
                Label("Einplanen", systemImage: "calendar.badge.plus")
            }
            .tint(.accentColor)
            // "Beim nächsten Mal" is the honest place for a spot nobody
            // got to (§20.3) — better than a pool that disappears with
            // the trip it hung off. It keeps the spot here too: this is
            // a copy into the collection, not a move out of the trip.
            Button {
                Task { await viewModel.keepForNextTime(osmRefs: [candidate.osmRef]) }
            } label: {
                Label("Für später merken", systemImage: "lightbulb")
            }
            .tint(.yellow)
        }
    }

    @ViewBuilder
    private func label(_ candidate: TripCandidate, leg: TripLeg) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Label {
                    // „Kolosseum (Colosseo)“: the name to plan with
                    // and the name on the sign, in one line (§10.4).
                    Text(TripSpotName.line(candidate.displayName, local: candidate.localName))
                        .font(.headline)
                } icon: {
                    Image(systemName: TripCategory.symbol(candidate.category))
                        .foregroundStyle(.secondary)
                }
                if candidate.isPhotoStop {
                    Image(systemName: "camera.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Fotostopp")
                }
                Spacer()
                Text(TripClock.duration(candidate.dwellMinutes))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // What somebody wrote next to it, which is the part that
            // actually decides an afternoon (§9.2).
            if let note = candidate.note, !note.isEmpty {
                Text(note).font(.caption).italic()
            }

            // Already in a day. Said rather than hidden — the same rule
            // the search follows, because a silently shorter list reads
            // as "not in the data".
            if plannedRefs(leg).contains(candidate.osmRef) {
                Label("schon eingeplant", systemImage: "checkmark.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // "Warum hier?" — a suggestion carries its reasons (§3.8, §8.3).
            ForEach(candidate.reasons, id: \.self) { reason in
                Text("· \(reason)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

/// What this trip has turned down, and the way back (§5).
///
/// A "no" you cannot take back is a deletion wearing a friendlier word,
/// so the list exists for the same reason the hiding does: the spot is
/// still out there, only the answer is kept.
struct TripHiddenSpotsView: View {
    @State var viewModel: TripPlannerViewModel

    var body: some View {
        List {
            if viewModel.hiddenSpots.isEmpty {
                ContentUnavailableView(
                    "Nichts ausgeblendet",
                    systemImage: "eye",
                    description: Text("Was ihr für diese Reise ausblendet, steht hier — und "
                                      + "lässt sich von hier aus wieder einblenden."),
                )
            } else {
                Section {
                    ForEach(viewModel.hiddenSpots) { hidden in
                        HStack {
                            Text(hidden.displayName)
                            Spacer()
                            Button("Einblenden") {
                                Task { await viewModel.unhide(osmRef: hidden.osmRef) }
                            }
                            .buttonStyle(.borderless)
                        }
                    }
                } footer: {
                    // Said plainly, because "einblenden" could be read
                    // as "put it back on Tuesday morning".
                    Text("Eingeblendet heißt: Der Planer darf ihn wieder vorschlagen. Auf den "
                         + "Plan kommt er dadurch nicht — das entscheidet die nächste Planung "
                         + "oder ihr selbst.")
                }
            }
        }
        .navigationTitle("Ausgeblendet")
        .plannerErrorBanner(viewModel.errorMessage, dismiss: { viewModel.errorMessage = nil })
        .navigationBarTitleDisplayMode(.inline)
        .task { await viewModel.loadHiddenSpots() }
    }
}

/// Which block a candidate list was opened to fill.
struct TripPoolTarget: Hashable {
    let dayIndex: Int
    let blockId: String
    let label: String
}
