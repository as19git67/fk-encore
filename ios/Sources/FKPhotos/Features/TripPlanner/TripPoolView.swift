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
/// Since the candidate ranking's stage 5 it is also where the group
/// says what it wants (§6.1): "Kandidaten" and "Wünsche" were two
/// screens over the same pool, one to manage it and one to vote on it.
/// Now every row carries the vote as a ring — tap it to answer — with
/// the names of who said what beneath, and the sections about the stay
/// as a whole (who has not said anything, fairness, "Damit neu planen")
/// stand at the head of the list.
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
    /// The candidate a fixed appointment is being written for (§4.4) —
    /// the ticket for a sight, which then stands at its hour.
    @State private var appointmentFor: TripCandidate?
    /// A candidate whose pin was tapped on the map.
    @State private var inspecting: TripCandidate?
    /// Set while the pin sheet is still on screen and the traveller has
    /// asked for the block picker. Two sheets cannot take the stage at
    /// once, so the picker waits for the first one to leave.
    /// Work an action queued for when the map's sheet is gone — the
    /// block picker cannot open while that sheet is still up.
    @State private var afterSheet: (@MainActor () -> Void)?
    /// List or map, remembered. Somebody who thinks in places thinks in
    /// places tomorrow too, and re-tapping the switch on every leg is a
    /// preference the app could simply have kept.
    @AppStorage("trip.pool.presentation") private var presentation = TripPoolPresentation.list
    @Environment(\.dismiss) private var dismiss

    /// The vote over this stay's spots (§6.1), loaded with the list.
    @State private var ballot: TripBallot?
    @State private var fairness: TripFairness?
    /// The spot a vote is on its way for.
    @State private var votingRef: String?
    @State private var isApplying = false

    /// Somebody is looking for one spot rather than working through the
    /// whole list; the sections about the stay as a whole step back.
    private var isSearching: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Voting belongs to the list as such. Opened to fill one block,
    /// the screen has one question — which spot goes here — and the
    /// rings would only be in the way.
    private var votes: Bool { placeInto == nil }

    private func ballotEntry(_ osmRef: String) -> TripBallotEntry? {
        guard votes else { return nil }
        return ballot?.entries.first { $0.osmRef == osmRef }
    }

    /// Who said anything about each spot, for the search.
    private var voterNames: [String: [String]] {
        guard let ballot, votes else { return [:] }
        return Dictionary(ballot.entries.map { entry in
            (entry.osmRef, entry.hearts + entry.wants + entry.ratherNots)
        }, uniquingKeysWith: { first, _ in first })
    }

    /// Spots of this stay that are already on a day: still up for a
    /// vote — a "lieber nicht" for something planned is worth saying —
    /// but not candidates any more, so they come after the list.
    private func plannedEntries(in leg: TripLeg) -> [TripBallotEntry] {
        guard let ballot, votes else { return [] }
        let inPool = Set(leg.pool.map(\.osmRef))
        let planned = ballot.entries.filter { !inPool.contains($0.osmRef) }
        return TripBallotSearch.filter(planned, query: query) { TripBallotDetails.of($0.osmRef, in: leg) }
    }

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
        .navigationTitle(placeInto == nil ? (ideas ? "Ideen" : "Kandidaten") : "Stopp hinzufügen")
        .plannerErrorBanner(viewModel.errorMessage, dismiss: { viewModel.errorMessage = nil })
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // Two shapes of one pool (§5.2): the list answers "what
            // did the planner find", the map "where is all this" —
            // and the second question is the one you ask before
            // deciding what fits into an afternoon (§3.1).
            TripPresentationToolbarItem(presentation: $presentation)
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
        .task { await loadBallot() }
        .refreshable {
            await viewModel.load()
            await loadBallot()
        }
        // A pool of a hundred and fifty candidates is what the planner
        // routinely produces; scrolling it to find the one somebody
        // mentioned at breakfast is not a plan. Always on the screen
        // rather than hidden above the first row: a search field you
        // have to know about to pull down is a search field most people
        // never find (§5.2).
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always),
                    prompt: placeInto == nil ? "Kandidaten, Orte und Namen durchsuchen" : "Kandidaten durchsuchen")
        .sheet(item: $inspecting, onDismiss: runAfterSheet) { candidate in
            if let leg {
                TripPinDetailSheet(
                    detail: TripPinDetail.of(candidate),
                    actions: candidateActions(candidate, later: { afterSheet = $0 }),
                    spot: TripSpotDetail(candidate),
                    mode: leg.transportMode,
                    onSave: { await viewModel.saveNote($0) },
                )
            }
        }
        .sheet(item: $placing) { candidate in
            NavigationStack {
                TripBlockPickerView(title: candidate.displayName, leg: leg,
                                    category: candidate.category) { blockId, dayIndex in
                    await viewModel.place(candidate, inBlock: blockId, onDay: dayIndex)
                }
            }
        }
        .sheet(item: $appointmentFor) { candidate in
            if let leg {
                TripFixpointSheet(
                    dayLabel: "Tag \((placeInto?.dayIndex ?? 0) + 1)",
                    spots: leg.spotChoices,
                    presetSpot: TripSpotChoice(osmRef: candidate.osmRef, name: candidate.displayName,
                                               plannedOn: nil),
                    days: leg.days.map { day in
                        TripDayChoice(dayIndex: day.dayIndex, label: dayChoiceLabel(day, in: leg))
                    },
                    presetDayIndex: placeInto?.dayIndex,
                ) { draft in
                    await viewModel.addFixpoint(draft, legIndex: legIndex)
                }
            }
        }
        .task { if viewModel.plan == nil { await viewModel.load() } }
    }

    /// "Tag 2 · Di., 12. Mai" — the day as the day screen names it.
    private func dayChoiceLabel(_ day: TripDay, in leg: TripLeg) -> String {
        let number = "Tag \(day.dayIndex + 1)"
        guard let date = leg.date(ofDayIndex: day.dayIndex) else { return number }
        return "\(number) · \(date)"
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
                    if let leg, let kind = blockKind(of: placeInto, in: leg) {
                        Text(kind == "meal"
                             ? "Gezeigt wird, was zu einer Mahlzeit passt: Restaurants und Cafés."
                             : "Restaurants gehören zur Mahlzeit und stehen hier nicht.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            if leg != nil, let ballot, votes, !isSearching {
                stayHead(ballot)
            }
            if let leg {
                if leg.pool.isEmpty {
                    emptyPool(systemImage: "tray")
                } else if matches(in: leg).isEmpty {
                    ContentUnavailableView.search(text: query)
                } else {
                    Section {
                        ForEach(matches(in: leg)) { candidate in
                            row(candidate, leg: leg)
                        }
                    } header: {
                        HStack(spacing: 6) {
                            Text(countLabel(leg))
                            if leg.isBeingSorted {
                                Spacer()
                                Label("wird noch sortiert", systemImage: "arrow.up.arrow.down")
                                    .labelStyle(.titleAndIcon)
                                    .textCase(nil)
                            }
                        }
                    } footer: {
                        Text(poolFooter)
                    }
                }
                let planned = plannedEntries(in: leg)
                if !planned.isEmpty {
                    Section {
                        ForEach(planned) { entry in
                            plannedRow(entry, in: leg)
                        }
                    } header: {
                        Text("Schon eingeplant")
                    } footer: {
                        Text("Auch was schon auf einem Tag steht, kann noch einen Wunsch bekommen.")
                    }
                }
            } else {
                ContentUnavailableView("Aufenthalt nicht gefunden", systemImage: "tray")
            }
        }
    }

    /// On a trip of ideas the list is the travellers' own (ideas plan,
    /// stage 1): it starts empty, and the empty screen names the ways in.
    private var ideas: Bool { viewModel.plan?.isIdeasTrip == true }

    @ViewBuilder
    private func emptyPool(systemImage: String) -> some View {
        if ideas {
            ContentUnavailableView(
                "Noch keine Ideen",
                systemImage: "lightbulb",
                description: Text("Ideen kommen über „Ort suchen“, über Teilen aus Apple Karten oder "
                                  + "Google Maps und über „Aus den Ideen übernehmen“ im Aufenthalt. "
                                  + "Erst was ihr hinzufügt, lässt sich auf einen Tag legen."),
            )
        } else {
            ContentUnavailableView(
                "Noch keine Kandidaten",
                systemImage: systemImage,
                description: Text("Was der Planer findet und was ihr selbst beisteuert, "
                                  + "sammelt sich hier."),
            )
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
                emptyPool(systemImage: "map")
            } else {
                pins(of: leg)
            }
        } else {
            ContentUnavailableView("Aufenthalt nicht gefunden", systemImage: "map")
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
            // What I said, as a ring around what it is (§6.1) — the
            // wishes map's language, now on the one map of the stay.
            ringTint: ballotEntry(candidate.osmRef).map(TripBallotPinKind.of).flatMap { $0 == .open ? nil : $0.colour },
            extentEnd: candidate.extent?.end,
            course: candidate.extent?.via ?? [],
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
            if votes, ballot != nil {
                Text("Ein Ring sagt, was du dir gewünscht hast. Antippen: abstimmen und Details lesen.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(Color(uiColor: .systemBackground).ignoresSafeArea(edges: .bottom))
    }

    /// Everything that can be done with a candidate — one list for the
    /// map's sheet and the detail screen, and the same actions the
    /// row's swipes carry (§5.2, §8.4). Out of the trial: the map could
    /// not keep a spot for next time, and the detail screen reached
    /// through the map could do nothing at all.
    ///
    /// `later` runs what opens a screen of its own (the block picker)
    /// once the screen the action was pressed on has gone.
    private func candidateActions(
        _ candidate: TripCandidate,
        later: @escaping @MainActor (@escaping @MainActor () -> Void) -> Void = { $0() },
    ) -> [TripPinSheetAction] {
        var actions: [TripPinSheetAction] = [
            TripPinSheetAction(
                id: "place",
                title: placeInto == nil ? "In einen Block setzen" : "Hier einplanen",
                systemImage: "calendar.badge.plus",
                footer: placeInto.map { "Für \($0.label), Tag \($0.dayIndex + 1)." },
            ) {
                guard let placeInto else {
                    later { placing = candidate }
                    return
                }
                if await viewModel.place(candidate, inBlock: placeInto.blockId, onDay: placeInto.dayIndex) {
                    dismiss()
                }
            },
            // A ticket for it (§4.4): the spot goes to that day at that
            // hour, and the planner does not put it anywhere else.
            TripPinSheetAction(id: "appointment", title: "Fester Termin …",
                               systemImage: "calendar.badge.clock") {
                later { appointmentFor = candidate }
            },
            // "Beim nächsten Mal" (§20.3): a copy into the collection;
            // the spot stays a candidate here.
            TripPinSheetAction(id: "keep", title: "Für später merken", systemImage: "lightbulb",
                               closes: false) {
                await viewModel.keepForNextTime(osmRefs: [candidate.osmRef])
            },
        ]
        // How much it matters (ideas plan, stage 3) — on a trip of ideas,
        // where the list is what the travellers said they want.
        if viewModel.plan?.isIdeasTrip == true {
            actions.append(contentsOf: TripIdeaPriority.actions(current: candidate.ideaPriority) { priority in
                await viewModel.setPriority(osmRef: candidate.osmRef, priority)
            })
        }
        // What I want of it (§6.1): the same answers as the ring on the
        // row, so the map's sheet and the detail screen can vote too.
        if let entry = ballotEntry(candidate.osmRef) {
            actions.append(contentsOf: voteActions(entry))
        }
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
                group: .remove,
            ) {
                await viewModel.drop(candidate)
            })
        } else {
            actions.append(TripPinSheetAction(
                id: "hide",
                title: "Für diese Reise ausblenden",
                systemImage: "eye.slash",
                role: .destructive,
                footer: "Der Planer schlägt ihn auf dieser Reise nicht mehr vor, auch beim "
                    + "nächsten Neuplanen nicht. Rückgängig oben unter „Ausgeblendet“.",
                group: .remove,
            ) {
                await viewModel.hide(osmRef: candidate.osmRef)
            })
        }
        return actions
    }

    /// Run what an action queued for when the map's sheet is gone.
    private func runAfterSheet() {
        let work = afterSheet
        afterSheet = nil
        work?()
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
        // Opened for one block, only what may go into it: somewhere to
        // eat for a meal block, no restaurant for a sightseeing one —
        // the same rule the block picker and the server apply (§10.3).
        let kind = placeInto.flatMap { target in
            leg.days.first { $0.dayIndex == target.dayIndex }?.blocks.first { $0.id == target.blockId }?.kind
        }
        return TripPoolFilter.matches(in: leg.pool, query: query, voices: voterNames).filter { candidate in
            kind.map { TripBlockTargets.fits(category: candidate.category, blockKind: $0) } ?? true
        }
    }

    private func blockKind(of target: TripPoolTarget, in leg: TripLeg) -> String? {
        leg.days.first { $0.dayIndex == target.dayIndex }?.blocks.first { $0.id == target.blockId }?.kind
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
                // The same actions as the map's sheet and the row's
                // swipes (§8.4).
                TripSpotActionSections(actions: candidateActions(candidate), close: closeDetail)
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
                    // The picture where the place has one (candidate
                    // ranking, stage 2); the category's symbol where it
                    // has none — never an empty frame.
                    if let image = candidate.image {
                        TripSpotThumbnail(image: image, height: 44, width: 44)
                            .accessibilityHidden(true)
                    } else {
                        Image(systemName: TripCategory.symbol(candidate.category))
                            .foregroundStyle(.secondary)
                    }
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
                voteRing(candidate.osmRef)
            }
            if let extent = candidate.extent {
                Text(extent.summary).font(.caption).foregroundStyle(.secondary)
            }
            TripIdeaChips(priority: candidate.ideaPriority, ticket: candidate.ticket,
                          closedOn: candidate.closedOn ?? [], openingHours: candidate.openingHours)

            // A stop longer than every block that takes spots is never
            // chosen by the planner — it keeps to the frame it was
            // given (§4.7). Said here, because otherwise the walk just
            // sits in the list looking passed over.
            if TripPoolFilter.needsMoreThanOneBlock(candidate, in: leg) {
                Label("länger als jeder Block — selbst einplanen, sie läuft dann in den nächsten hinein",
                      systemImage: "arrow.turn.down.right")
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

            // "Warum hier?" — the first reason, which is the strongest:
            // the model's sentence, "von euch hinzugefügt", or what the
            // open data says (§3.8, §8.3). The rest is in the details.
            if let reason = candidate.reasons.first {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // Who said what, in names rather than a number (§6.1).
            if let voices = ballotEntry(candidate.osmRef)?.voices {
                Text(voices).font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    // MARK: - The vote (§6.1)

    /// What everybody can see before the list: re-planning with the
    /// wishes, the fairness account, who has not said anything yet.
    @ViewBuilder
    private func stayHead(_ ballot: TripBallot) -> some View {
        Section {
            Button {
                Task { await apply() }
            } label: {
                HStack {
                    Label("Damit neu planen", systemImage: "arrow.triangle.2.circlepath")
                    Spacer()
                    if isApplying { ProgressView() }
                }
            }
            .disabled(isApplying)
        } footer: {
            Text("Wünsche ändern den Plan nicht von selbst — sonst wäre er nach jedem Antippen ein anderer.")
        }
        if let sentence = fairness?.sentence {
            Section {
                Text(sentence).font(.footnote)
            } header: {
                Text("Fairness")
            }
        }
        if !ballot.silent.isEmpty {
            Section {
                Text("Noch nichts gesagt haben: \(ballot.silent.joined(separator: ", "))")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var poolFooter: String {
        var text = "Der Planer wählt aus den Kandidaten, was in einen Block passt. "
            + "Was hier liegt, ist nicht verplant — es steht bereit."
        if votes, let ballot {
            text += " Ein Herzenswunsch kommt in den Plan, solange er zeitlich möglich ist — "
                + "unabhängig von der Mehrheit. Noch \(ballot.heartsLeft) von \(ballot.heartQuota) frei."
        }
        return text
    }

    /// The vote as a ring: its colour and symbol say what I answered,
    /// a tap offers the answers (§6.1). The same ring the map draws.
    @ViewBuilder
    private func voteRing(_ osmRef: String) -> some View {
        if let entry = ballotEntry(osmRef) {
            Menu {
                TripSpotActionMenuItems(actions: voteActions(entry))
            } label: {
                ZStack {
                    Circle()
                        .stroke(TripBallotPinKind.of(entry).colour, lineWidth: 2.5)
                        .frame(width: 30, height: 30)
                    if votingRef == osmRef {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: TripBallotPinKind.of(entry).symbolName)
                            .font(.caption)
                            .foregroundStyle(TripBallotPinKind.of(entry).colour)
                    }
                }
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .disabled(votingRef != nil)
            .accessibilityLabel("Dein Wunsch: \(TripBallotPinKind.of(entry).label)")
        }
    }

    /// Will ich, egal, lieber nicht, and the heart — one list for the
    /// ring, the map's sheet and the detail screen.
    private func voteActions(_ entry: TripBallotEntry) -> [TripPinSheetAction] {
        var actions = TripVote.allCases.map { vote in
            TripPinSheetAction(
                id: "vote-\(vote.rawValue)",
                title: vote.label,
                systemImage: entry.myVote == vote.rawValue && !entry.myHeart ? "checkmark" : vote.symbolName,
                closes: false,
                group: .vote,
            ) {
                await cast(entry.osmRef, vote, heart: false)
            }
        }
        let heartsLeft = ballot?.heartsLeft ?? 0
        if entry.myHeart || heartsLeft > 0 {
            actions.append(TripPinSheetAction(
                id: "heart",
                title: entry.myHeart ? "Kein Herzenswunsch mehr" : "Zum Herzenswunsch machen",
                systemImage: entry.myHeart ? "heart.slash" : "heart",
                footer: entry.myHeart ? nil : "Noch \(heartsLeft) frei. Ein Herzenswunsch kommt in den Plan, "
                    + "solange er zeitlich möglich ist.",
                closes: false,
                group: .vote,
            ) {
                await cast(entry.osmRef, .want, heart: !entry.myHeart)
            })
        }
        return actions
    }

    /// A spot that is already on a day, with its vote.
    private func plannedRow(_ entry: TripBallotEntry, in leg: TripLeg) -> some View {
        let details = TripBallotDetails.of(entry.osmRef, in: leg)
        return NavigationLink {
            if let spot = details.spot {
                TripSpotDetailView(spot: spot, mode: leg.transportMode, onSave: nil) { _ in EmptyView() }
            }
        } label: {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(entry.label)
                        .fixedSize(horizontal: false, vertical: true)
                    if !details.line.isEmpty {
                        Label(details.line, systemImage: TripCategory.symbol(entry.category))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let voices = entry.voices {
                        Text(voices).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                voteRing(entry.osmRef)
            }
        }
        .disabled(details.spot == nil)
    }

    private func loadBallot() async {
        guard votes else { return }
        do {
            try await loadVotes()
            fairness = try await APIClient.shared.get("/trip-planner/plans/\(viewModel.planId)/fairness")
        } catch {
            viewModel.errorMessage = TripErrorText.describe(error)
        }
    }

    /// The ballot alone: after a vote only this changes.
    private func loadVotes() async throws {
        ballot = try await APIClient.shared.get(
            "/trip-planner/plans/\(viewModel.planId)/votes",
            query: ["legIndex": String(legIndex)],
        )
    }

    private func cast(_ osmRef: String, _ vote: TripVote, heart: Bool) async {
        votingRef = osmRef
        defer { votingRef = nil }
        do {
            let _: TripCastVoteResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(viewModel.planId)/votes",
                body: TripCastVoteRequest(legIndex: legIndex, osmRef: osmRef, value: vote.rawValue, heart: heart),
            )
            try await loadVotes()
        } catch {
            viewModel.errorMessage = TripErrorText.describe(error)
        }
    }

    /// "Damit neu planen": once, when somebody asks — voting itself
    /// never re-plans (§6.1).
    private func apply() async {
        isApplying = true
        defer { isApplying = false }
        do {
            let _: TripPlanResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(viewModel.planId)/votes/apply", body: TripEmptyBody())
            await viewModel.load()
            await loadBallot()
        } catch {
            viewModel.errorMessage = TripErrorText.describe(error)
        }
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
