import SwiftUI

/// The itinerary: the whole trip on one screen
/// (documentation/plans/reiseverlauf.md, stage 2).
///
/// A trip with three cities and the journeys between them used to take
/// seven sheets, and the same fact — when the group arrives, how long
/// it stays — was typed in two or three of them, each overwriting the
/// other. Here it is one vertical timeline: a card per stay, a card
/// per journey between two stays, home as a plain row at both ends
/// when the trip knows it, and **one date** in the header. Every other
/// date on the screen is computed from that one and the lengths on the
/// cards, so changing a stay from three days to four moves everything
/// after it at once, on screen, before anything is saved.
///
/// Editing happens in place: a tap unfolds a card into its fields, no
/// sheet. "Sichern" sends the whole chain in one request
/// (`PUT …/itinerary`); the server plans what changed and refuses what
/// it must — a stop somebody already ticked off on a day that would be
/// re-planned — before writing anything.
struct TripItineraryView: View {
    @State var viewModel: TripPlannerViewModel
    /// What to open unfolded, when the screen was entered from a leg or
    /// from one of the times a journey wrote on a day.
    var focus: TripItineraryFocus? = nil

    @Environment(\.dismiss) private var dismiss

    @State private var draft: TripItineraryDraft?
    /// What came from the server, to know whether anything changed.
    @State private var original: TripItineraryDraft?
    @State private var expanded: Set<TripItineraryItem.ID> = []
    /// Whether the draft differs from what was loaded. Kept as state
    /// and refreshed on every change of the draft, rather than compared
    /// on the fly: the toolbar's "Sichern" is what tells the traveller
    /// that typing landed, and it has to follow every keystroke.
    @State private var isDirty = false
    @State private var loadError: String?
    @State private var errorMessage: String?
    @State private var isSaving = false
    @State private var confirmCancel = false
    @State private var removing: TripItineraryItem?

    /// A place search per stay that is looking for its lodging. One
    /// shared search lost what was typed for one stay the moment a
    /// second stay was added or another stay's "Ändern" was tapped.
    @State private var placeFinders: [TripItineraryItem.ID: TripPlaceFinderModel] = [:]
    @State private var searchingPlaceFor: TripItineraryItem.ID?

    /// Looking for where home is (§22.7), and what the person said in
    /// the settings, for the trip made before it was known.
    @State private var homeFinder = TripPlaceFinderModel()
    @State private var userHome: TripHome?
    @State private var savingHome = false

    /// The one journey the planner would suggest (§22.7), or nil.
    @State private var suggestion: TripTransitSuggestion?

    /// Which item is choosing its mode, as a sheet. Not a
    /// `NavigationLink`: a link anywhere in a list row makes the whole
    /// row tappable, and a card is one row — a tap on "Noch nichts
    /// gebucht" opened the choice of modes.
    @State private var modeChoice: ModeChoice?
    private struct ModeChoice: Identifiable {
        let id: TripItineraryItem.ID
        let choices: [TripTransportMode]
    }

    /// The one card height Apple asks for: a control under 44 points
    /// is a control somebody misses (HIG, "Layout").
    private static let rowHeight: CGFloat = 44

    var body: some View {
        Group {
            if let draft {
                list(draft)
            } else if let loadError {
                ContentUnavailableView {
                    Label("Der Reiseverlauf lässt sich nicht laden", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(loadError)
                } actions: {
                    Button("Noch einmal") { Task { await load() } }
                }
            } else {
                ProgressView("Reiseverlauf wird geladen …")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle("Reiseverlauf")
        .navigationBarTitleDisplayMode(.inline)
        .plannerErrorBanner(errorMessage, dismiss: { errorMessage = nil })
        // Typed input must not vanish on a swipe; "Abbrechen" asks.
        .interactiveDismissDisabled(isDirty)
        .onChange(of: draft) { refreshDirty() }
        .onChange(of: original) { refreshDirty() }
        .confirmationDialog("Änderungen verwerfen?", isPresented: $confirmCancel, titleVisibility: .visible) {
            Button("Verwerfen", role: .destructive) { dismiss() }
            Button("Weiter bearbeiten", role: .cancel) {}
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Abbrechen") {
                    if isDirty { confirmCancel = true } else { dismiss() }
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                // Enabled as soon as anything changed. What still keeps
                // the chain from being saved is said on the tap, in
                // the banner, rather than by a button that stays grey
                // without a word.
                Button {
                    Task { await save() }
                } label: {
                    if isSaving { ProgressView() } else { Text("Sichern") }
                }
                .disabled(isSaving || !isDirty)
            }
        }
        .alert("Aufenthalt entfernen?", isPresented: Binding(
            get: { removing != nil }, set: { if !$0 { removing = nil } }),
               presenting: removing) { stay in
            Button("Entfernen", role: .destructive) {
                draft?.removeStay(id: stay.id)
                removing = nil
            }
            Button("Abbrechen", role: .cancel) { removing = nil }
        } message: { stay in
            Text(stay.legId == nil
                 ? "Der Aufenthalt ist noch nicht gesichert und geht einfach weg."
                 : "„\(draft?.title(of: stay) ?? "Der Aufenthalt")“ wird beim Sichern mit allen Tagen und allen "
                   + "Kandidaten gelöscht — auch mit dem, was jemand von Hand hinzugefügt hat. "
                   + "Die Weiterreise davor führt dann zum nächsten Aufenthalt.")
        }
        .sheet(item: $modeChoice) { choice in
            NavigationStack {
                TripTransportModeChoiceView(mode: Binding(
                    get: { draft?[choice.id]?.transportMode ?? .foot },
                    set: { setMode($0, of: choice.id) },
                ), choices: choice.choices)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Fertig") { modeChoice = nil }
                    }
                }
            }
        }
        .task {
            // Once. `.task` runs again whenever the view comes back
            // into view — after a sheet, after a pushed page — and a
            // second load threw away every unsaved change, the stay
            // just added among them.
            if draft == nil { await load() }
            if userHome == nil { userHome = await TripUserHome.load() }
        }
    }

    // MARK: - The list

    private func list(_ draft: TripItineraryDraft) -> some View {
        let dated = draft.dated()
        let offsets = TripItineraryText.dayOffsets(of: draft)
        let stays = draft.stays
        return List {
            dateSection(draft)
            homeSection(draft)
            if let suggestion, let target = suggestionTarget(suggestion, in: draft) {
                suggestionSection(suggestion, target: target)
            }

            Section {
                // The way there, when the trip knows its home. Not part
                // of the movable rows: it has no stay to move with.
                if let first = draft.items.first, first.isJourney {
                    journeyCard(first, dated: dated[0], offsets: offsets[0], in: draft)
                        .listRowSeparator(.hidden)
                }
                ForEach(Array(stays.enumerated()), id: \.element.id) { position, stay in
                    let index = draft.index(of: stay.id) ?? 0
                    VStack(spacing: 10) {
                        // The journey into this stay, from the one before.
                        if position > 0, index > 0, draft.items[index - 1].isJourney {
                            journeyCard(draft.items[index - 1], dated: dated[index - 1],
                                        offsets: offsets[index - 1], in: draft)
                        }
                        insertLine(before: stay, position: position, in: draft)
                        stayCard(stay, dated: dated[index], offsets: offsets[index], in: draft)
                    }
                    .listRowSeparator(.hidden)
                    .swipeActions(edge: .trailing) {
                        if stays.count > 1 {
                            Button(role: .destructive) { removing = stay } label: {
                                Label("Entfernen", systemImage: "trash")
                            }
                        }
                    }
                }
                // After the last stay: add one, then the way home.
                addStayRow(draft)
                    .listRowSeparator(.hidden)
                if let last = draft.items.last, last.isJourney, draft.items.count > 1 {
                    journeyCard(last, dated: dated[dated.count - 1],
                                offsets: offsets[offsets.count - 1], in: draft)
                        .listRowSeparator(.hidden)
                }
            } footer: {
                let problems = draft.problems()
                if !problems.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(problems, id: \.self) { problem in
                            Label(problem, systemImage: "exclamationmark.circle")
                        }
                    }
                } else {
                    Text("Jeder Aufenthalt hat seinen eigenen Ausgangspunkt, sein eigenes Verkehrsmittel "
                         + "und seine eigenen Kandidaten. Die Daten folgen aus dem ersten Tag und den "
                         + "Längen: eine Nacht mehr hier verschiebt alles danach um einen Tag.")
                }
            }
        }
        .listStyle(.insetGrouped)
        // Every button on a card is its own target. A button in its
        // default style inside a list row fires on a tap anywhere in
        // the row, and a card is one row: a tap on a hint text picked
        // the first place of a search nobody had chosen.
        .buttonStyle(.borderless)
    }

    // MARK: - Header: the one date, and home

    private func dateSection(_ draft: TripItineraryDraft) -> some View {
        Section {
            if let start = draft.startDate {
                DatePicker("Erster Tag", selection: Binding(
                    get: { TripCalendar.date(fromIsoDay: start) ?? Date() },
                    set: { self.draft?.startDate = TripCalendar.isoDay($0) },
                ), displayedComponents: .date)
                Button("Datum entfernen", role: .destructive) { self.draft?.startDate = nil }
            } else {
                HStack {
                    Text("Noch ohne Datum")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Datum festlegen") {
                        self.draft?.startDate = TripCalendar.isoDay(Date())
                    }
                }
            }
        } header: {
            Text("Wann")
        } footer: {
            if let last = draft.lastDate, let start = draft.startDate,
               let days = TripCalendar.days(from: start, to: last) {
                Text("Bis \(TripItineraryText.shortDate(last)) · \(days + 1) Tage. Alle anderen Daten "
                     + "folgen aus diesem einen.")
            } else {
                Text("Ohne Datum heißen die Tage „Tag 1“ bis „Tag n“. Das Datum lässt sich jederzeit "
                     + "nachtragen, alles andere steht dann schon.")
            }
        }
    }

    private func homeSection(_ draft: TripItineraryDraft) -> some View {
        Section {
            if let home = viewModel.plan?.home {
                HStack {
                    Label(home.displayLabel, systemImage: "house")
                    Spacer()
                    Button("Entfernen") { Task { await clearHome() } }
                        .buttonStyle(.borderless)
                        .disabled(savingHome)
                }
            } else {
                if let mine = userHome {
                    Button {
                        Task { await setHome(TripPlace(name: mine.displayLabel, subtitle: nil,
                                                       latitude: mine.lat, longitude: mine.lon)) }
                    } label: {
                        Label("„\(mine.displayLabel)“ übernehmen", systemImage: "house")
                    }
                    .disabled(savingHome)
                }
                TripPlaceFinderRows(model: homeFinder, picked: nil) { place in
                    homeFinder.clearResults()
                    Task { await setHome(place) }
                }
            }
        } header: {
            Text("Zuhause")
        } footer: {
            Text("Von hier geht es los, und hierher zurück. Mit einem Zuhause stehen Anreise und "
                 + "Heimreise als Weiterreisen im Verlauf.")
        }
    }

    // MARK: - The suggestion

    /// The journey the suggestion is about: the one after the leg at
    /// `afterLegIndex`, or the way there for −1. Only while that
    /// journey still has its times open.
    private func suggestionTarget(_ suggestion: TripTransitSuggestion,
                                  in draft: TripItineraryDraft) -> TripItineraryItem.ID? {
        let journey: TripItineraryItem?
        if suggestion.afterLegIndex < 0 {
            journey = draft.items.first?.isJourney == true ? draft.items.first : nil
        } else {
            guard let leg = viewModel.plan?.legs.first(where: { $0.position == suggestion.afterLegIndex }),
                  let stay = draft.items.first(where: { $0.isStay && $0.legId == leg.id }),
                  let index = draft.index(of: stay.id), index + 1 < draft.items.count
            else { return nil }
            journey = draft.items[index + 1]
        }
        guard let journey, journey.isJourney, !journey.isTimed else { return nil }
        return journey.id
    }

    private func suggestionSection(_ suggestion: TripTransitSuggestion, target: TripItineraryItem.ID) -> some View {
        Section {
            Label(suggestion.sentence, systemImage: "arrow.triangle.turn.up.right.diamond")
                .font(.subheadline)
            HStack {
                Button("Übernehmen") {
                    guard var journey = draft?[target] else { return }
                    journey.departAt = suggestion.departAt
                    journey.arriveAt = suggestion.arriveAt
                    journey.mode = suggestion.mode
                    if let from = suggestion.departDate, let to = suggestion.arriveDate,
                       let nights = TripCalendar.days(from: from, to: to) {
                        journey.nights = max(0, min(TripItineraryDraft.maxJourneyNights, nights))
                    }
                    draft?[target] = journey
                    expanded.insert(target)
                    self.suggestion = nil
                }
                .buttonStyle(.borderedProminent)
                Button("Nein") { dismissSuggestion(suggestion) }
                    .buttonStyle(.bordered)
            }
            .controlSize(.small)
        }
    }

    // MARK: - Cards

    private func binding(_ id: TripItineraryItem.ID) -> Binding<TripItineraryItem> {
        Binding(
            get: { draft?[id] ?? TripItineraryItem(kind: .stay) },
            set: { draft?[id] = $0 },
        )
    }

    private func toggleExpanded(_ id: TripItineraryItem.ID) {
        withAnimation(.snappy) {
            if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
        }
    }

    /// The thin line with a plus between two cards: a stay goes in
    /// here, and the journey into it comes with it.
    private func insertLine(before stay: TripItineraryItem, position: Int, in draft: TripItineraryDraft) -> some View {
        HStack {
            Rectangle().fill(.quaternary).frame(height: 1)
            Button {
                let previous = position > 0 ? draft.stays[position - 1].id : nil
                if let newId = self.draft?.insertStay(after: previous) { startEditing(newStay: newId) }
            } label: {
                Image(systemName: "plus.circle.fill")
                    .font(.title3)
                    .foregroundStyle(.tint)
                    .frame(width: Self.rowHeight, height: Self.rowHeight)
                    .contentShape(.rect)
            }
            .buttonStyle(.borderless)
            .disabled(!draft.canAddStay)
            .accessibilityLabel("Aufenthalt hier einfügen")
            Rectangle().fill(.quaternary).frame(height: 1)
        }
    }

    private func addStayRow(_ draft: TripItineraryDraft) -> some View {
        Button {
            if let newId = self.draft?.insertStay(after: draft.stays.last?.id) { startEditing(newStay: newId) }
        } label: {
            Label("Aufenthalt hinzufügen", systemImage: "plus.circle")
                .frame(minHeight: Self.rowHeight)
        }
        .disabled(!draft.canAddStay)
    }

    /// A new stay opens unfolded with its own, empty place search.
    /// Whatever another stay has typed into its search stays there.
    private func startEditing(newStay id: TripItineraryItem.ID) {
        expanded.insert(id)
        placeFinders[id] = TripPlaceFinderModel()
        searchingPlaceFor = id
    }

    private func placeFinder(for id: TripItineraryItem.ID) -> TripPlaceFinderModel {
        placeFinders[id] ?? TripPlaceFinderModel()
    }

    private func refreshDirty() {
        isDirty = draft != nil && draft != original
    }

    /// One field of a card: a row the height of a list row, so the
    /// controls do not sit on top of each other. The card used to stack
    /// its toggles and steppers ten points apart.
    private func fieldRow<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .frame(maxWidth: .infinity, minHeight: Self.rowHeight, alignment: .leading)
    }

    /// The mode row of a card: looks like `TripTransportModePicker`,
    /// but opens the choices as a sheet from a button of its own.
    private func modeRow(_ item: TripItineraryItem, choices: [TripTransportMode]) -> some View {
        Button {
            modeChoice = ModeChoice(id: item.id, choices: choices)
        } label: {
            HStack {
                Text("Fortbewegung")
                    .foregroundStyle(.primary)
                Spacer()
                Label(item.transportMode.label, systemImage: item.transportMode.systemImage)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity, minHeight: Self.rowHeight)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Fortbewegung: \(item.transportMode.label)")
    }

    private func setMode(_ newMode: TripTransportMode, of id: TripItineraryItem.ID) {
        guard var updated = draft?[id] else { return }
        // A stay's radius still at the old mode's default follows the
        // mode; one somebody set stays.
        if updated.isStay, let current = updated.radiusM {
            updated.radiusM = TripReach.radius(movingFrom: updated.transportMode, to: newMode, current: current)
        }
        updated.transportMode = newMode
        draft?[id] = updated
    }

    @ViewBuilder
    private func stayCard(_ stay: TripItineraryItem, dated: TripItineraryDated,
                          offsets: (first: Int, last: Int), in draft: TripItineraryDraft) -> some View {
        let isOpen = expanded.contains(stay.id)
        VStack(alignment: .leading, spacing: 10) {
            Button {
                toggleExpanded(stay.id)
            } label: {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(draft.title(of: stay)).font(.headline)
                        HStack(spacing: 6) {
                            Text(TripItineraryText.stayLength(days: stay.days ?? 1))
                            Text("·")
                            Label(stay.transportMode.label, systemImage: stay.transportMode.systemImage)
                                .lineLimit(1)
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        Text(TripItineraryText.span(dated, dayOffsets: offsets))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if stay.anchor == nil {
                            Label("Noch kein Ort", systemImage: "mappin.slash")
                                .font(.caption2)
                                .foregroundStyle(Color.accentColor)
                        } else if stay.anchorRadiusM != nil {
                            Text("Unterkunft noch offen")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        if stay.quartersAboard == true {
                            Label(stay.tenderPort == true ? "Unterkunft an Bord · Tenderhafen" : "Unterkunft an Bord",
                                  systemImage: "ferry")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)

            if isOpen {
                VStack(alignment: .leading, spacing: 0) {
                    stayFields(stay, in: draft)
                }
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.4), in: .rect(cornerRadius: 12))
    }

    @ViewBuilder
    private func stayFields(_ stay: TripItineraryItem, in draft: TripItineraryDraft) -> some View {
        let item = binding(stay.id)
        Divider()
        fieldRow {
            TextField("Name (optional)", text: Binding(
                get: { item.wrappedValue.title ?? "" },
                set: { item.wrappedValue.title = $0 },
            ))
            .textInputAutocapitalization(.words)
        }
        Divider()

        // The lodging: where every day starts and ends (§4.2).
        if let place = stay.place, searchingPlaceFor != stay.id {
            fieldRow {
                HStack {
                    Label(place.name, systemImage: "mappin.circle.fill").lineLimit(2)
                    Spacer()
                    Button("Ändern") {
                        let finder = placeFinder(for: stay.id)
                        finder.query = place.name
                        finder.clearResults()
                        placeFinders[stay.id] = finder
                        searchingPlaceFor = stay.id
                    }
                }
            }
        } else {
            let finder = placeFinder(for: stay.id)
            TripPlaceFinderRows(model: finder, picked: nil) { place in
                item.wrappedValue.place = place
                finder.clearResults()
                searchingPlaceFor = nil
            }
            .frame(minHeight: Self.rowHeight)
            // Keep the search this card got, so what is typed survives
            // the next redraw of the list.
            .onAppear { if placeFinders[stay.id] == nil { placeFinders[stay.id] = finder } }
            if stay.place != nil {
                fieldRow { Button("Ort behalten") { searchingPlaceFor = nil } }
            }
        }
        Text("Hotel, Campingplatz oder Adresse — hier fängt jeder Tag an und hier endet er. "
             + "Eine Stadt geht auch; dann plant der Planer um deren Mitte herum.")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .padding(.bottom, 8)
        Divider()

        fieldRow {
            Toggle("Noch nichts gebucht", isOn: Binding(
                get: { item.wrappedValue.anchorRadiusM != nil },
                set: { on in item.wrappedValue.anchorRadiusM = on ? (item.wrappedValue.anchorRadiusM ?? 1_000) : nil },
            ))
        }
        if stay.anchorRadiusM != nil {
            TripRadiusPicker(metres: Binding(
                get: { item.wrappedValue.anchorRadiusM ?? 1_000 },
                set: { item.wrappedValue.anchorRadiusM = $0 },
            ))
            .padding(.bottom, 8)
        }
        Divider()

        fieldRow {
            Stepper(value: Binding(
                get: { item.wrappedValue.days ?? 1 },
                set: { item.wrappedValue.days = $0 },
            ), in: TripItineraryDraft.minStayDays...TripItineraryDraft.maxStayDays) {
                Text(TripItineraryText.stayLength(days: stay.days ?? 1))
            }
        }
        Divider()

        fieldRow {
            modeRow(stay, choices: TripTransportMode.forPlaces)
        }
        Divider()

        fieldRow {
            Toggle("Unterkunft fährt mit", isOn: Binding(
                get: { item.wrappedValue.quartersAboard ?? false },
                set: { on in
                    item.wrappedValue.quartersAboard = on
                    if !on { item.wrappedValue.tenderPort = false }
                },
            ))
        }
        if stay.quartersAboard == true {
            fieldRow {
                Toggle("Tenderhafen", isOn: Binding(
                    get: { item.wrappedValue.tenderPort ?? false },
                    set: { item.wrappedValue.tenderPort = $0 },
                ))
            }
            // The sea between two ports is a journey by ship, and a day
            // ashore is planned on the day itself ("Ausflug planen"):
            // the card lists no days. It used to, and called a day
            // without an outing a "Seetag" — on a port call it is the
            // day at the berth.
            Text("Die Unterkunft ist der Liegeplatz, und die Abfahrt heißt „Alle an Bord“ mit einer "
                 + "Stunde Puffer — in einem Tenderhafen anderthalb. Jeder Hafen ist ein eigener "
                 + "Aufenthalt; die Seetage dazwischen sind eine Weiterreise mit dem Schiff.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .padding(.bottom, 8)
        }

        if draft.stayCount > 1 {
            Divider()
            // Where the stay sits in the trip, from the card itself:
            // the list's edit mode behind a pencil in the toolbar was a
            // button nobody knew when to press.
            let position = draft.stays.firstIndex { $0.id == stay.id } ?? 0
            fieldRow {
                HStack(spacing: 16) {
                    Button {
                        withAnimation(.snappy) { self.draft?.moveStay(id: stay.id, up: true) }
                    } label: {
                        Label("Nach oben", systemImage: "arrow.up")
                    }
                    .disabled(position == 0)
                    Button {
                        withAnimation(.snappy) { self.draft?.moveStay(id: stay.id, up: false) }
                    } label: {
                        Label("Nach unten", systemImage: "arrow.down")
                    }
                    .disabled(position == draft.stayCount - 1)
                    Spacer()
                    Button(role: .destructive) {
                        removing = stay
                    } label: {
                        Label("Entfernen", systemImage: "trash")
                    }
                }
            }
        }
    }


    @ViewBuilder
    private func journeyCard(_ journey: TripItineraryItem, dated: TripItineraryDated,
                             offsets: (first: Int, last: Int), in draft: TripItineraryDraft) -> some View {
        let isOpen = expanded.contains(journey.id)
        let (from, to) = draft.ends(of: journey)
        let before = draft.stay(before: journey.id)
        let after = draft.stay(after: journey.id)
        let name = before == nil ? "Anreise nach \(to)"
            : after == nil ? "Heimreise von \(from)"
            : journey.transportMode == .ship ? "An Bord nach \(to)"
            : "Weiterreise nach \(to)"
        VStack(alignment: .leading, spacing: 10) {
            Button {
                toggleExpanded(journey.id)
            } label: {
                HStack(alignment: .top) {
                    Image(systemName: journey.transportMode.systemImage)
                        .foregroundStyle(.secondary)
                        .frame(width: 22)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(name).font(.subheadline.weight(.semibold))
                        Text(TripItineraryText.journeyLine(journey))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(TripItineraryText.span(dated, dayOffsets: offsets))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)

            if isOpen {
                VStack(alignment: .leading, spacing: 0) {
                    journeyFields(journey)
                }
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(.quaternary, style: StrokeStyle(lineWidth: 1, dash: [5, 4])),
        )
    }

    @ViewBuilder
    private func journeyFields(_ journey: TripItineraryItem) -> some View {
        let item = binding(journey.id)
        Divider()
        optionalTime("Abfahrt", clock: Binding(
            get: { item.wrappedValue.departAt },
            set: { item.wrappedValue.departAt = $0 },
        ), defaultMinutes: 10 * 60)
        Divider()
        optionalTime("Ankunft", clock: Binding(
            get: { item.wrappedValue.arriveAt },
            set: { item.wrappedValue.arriveAt = $0 },
        ), defaultMinutes: 16 * 60)
        Divider()
        fieldRow {
            // In days, not nights: "1 Nacht unterwegs" read as driving
            // through the night, when all it says is that the arrival
            // is a day later.
            Stepper(value: Binding(
                get: { item.wrappedValue.nights ?? 0 },
                set: { item.wrappedValue.nights = $0 },
            ), in: 0...TripItineraryDraft.maxJourneyNights) {
                Text(TripItineraryText.arrival(nights: journey.nights ?? 0))
            }
        }
        Divider()
        fieldRow {
            modeRow(journey, choices: TripTransportMode.allCases)
        }
        Text(Self.journeyHint(journey))
            .font(.caption2)
            .foregroundStyle(.secondary)
            .padding(.top, 8)
    }

    /// What the journey will do to the plan, said before it is saved.
    static func journeyHint(_ journey: TripItineraryItem) -> String {
        guard journey.isTimed else {
            return "Solange die Zeiten offen sind, endet der Aufenthalt davor mit dem Tag und der "
                + "danach beginnt mit dem Morgen."
        }
        let sameDay = (journey.nights ?? 0) == 0
        switch journey.transportMode {
        case .car, .bike, .foot:
            return sameDay
                ? "Der Planer sucht Orte am Weg, deren Umweg noch in die Zeit passt, und plant sie "
                    + "in einen Block „Unterwegs“."
                : "Über mehrere Tage wird nichts hineingeplant — die Weiterreise sagt nur, wo ihr seid."
        case .ship:
            return "An Bord wird nichts hineingeplant — die Tage sagen, dass ihr auf See seid."
        case .transit:
            return "Mit Bahn oder Bus wird nichts hineingeplant — die Weiterreise sagt nur, wo ihr seid."
        case .plane:
            return "Im Flugzeug wird nichts hineingeplant — die Weiterreise sagt nur, wo ihr seid."
        }
    }

    /// A time that may simply not be known yet. A `DatePicker` cannot
    /// say "unknown", and midnight would be a departure nobody said
    /// (§15.3) — so the toggle carries the knowledge and the picker
    /// only the hour.
    @ViewBuilder
    private func optionalTime(_ label: String, clock: Binding<String?>, defaultMinutes: Int) -> some View {
        fieldRow {
            Toggle(label, isOn: Binding(
                get: { clock.wrappedValue != nil },
                set: { on in clock.wrappedValue = on ? (clock.wrappedValue ?? TripClock.format(defaultMinutes)) : nil },
            ))
        }
        if let current = clock.wrappedValue {
            fieldRow {
                DatePicker("Uhrzeit", selection: Binding(
                    get: {
                        let minutes = TripClock.minutes(fromClock: current) ?? defaultMinutes
                        return Calendar.current.date(bySettingHour: minutes / 60, minute: minutes % 60,
                                                     second: 0, of: Date()) ?? Date()
                    },
                    set: { date in
                        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
                        clock.wrappedValue = TripClock.format((parts.hour ?? 0) * 60 + (parts.minute ?? 0))
                    },
                ), displayedComponents: .hourAndMinute)
            }
        }
    }

    // MARK: - Loading and saving

    private func load() async {
        loadError = nil
        do {
            let response: TripItineraryResponse = try await APIClient.shared.get(
                "/trip-planner/plans/\(viewModel.planId)/itinerary")
            let loaded = TripItineraryDraft(response: response)
            draft = loaded
            original = loaded
            refreshDirty()
            if let focus, let item = loaded.item(focused: focus) {
                expanded.insert(item.id)
            }
            // A stay that came back without a place looks for one.
            for stay in loaded.stays where stay.anchor == nil {
                placeFinders[stay.id] = TripPlaceFinderModel()
                searchingPlaceFor = searchingPlaceFor ?? stay.id
            }
            if viewModel.plan == nil { await viewModel.load() }
            await loadSuggestion()
        } catch {
            loadError = TripErrorText.describe(error)
        }
    }

    private func save() async {
        guard let draft else { return }
        let problems = draft.problems()
        guard problems.isEmpty else {
            // Said where the tap was, not with a grey button.
            errorMessage = problems.joined(separator: "\n")
            return
        }
        isSaving = true
        defer { isSaving = false }
        do {
            let response: TripPlanResponse = try await APIClient.shared.put(
                "/trip-planner/plans/\(viewModel.planId)/itinerary", body: draft.request)
            viewModel.replace(with: response)
            errorMessage = nil
            dismiss()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    private func setHome(_ place: TripPlace) async {
        savingHome = true
        defer { savingHome = false }
        struct Body: Encodable {
            let lat: Double
            let lon: Double
            let label: String
        }
        do {
            let response: TripPlanResponse = try await APIClient.shared.patch(
                "/trip-planner/plans/\(viewModel.planId)/home",
                body: Body(lat: place.latitude, lon: place.longitude, label: place.name))
            viewModel.replace(with: response)
            draft?.setHome(place.name)
            original?.setHome(place.name)
            await loadSuggestion()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    private func clearHome() async {
        savingHome = true
        defer { savingHome = false }
        struct Body: Encodable { let clear: Bool }
        do {
            let response: TripPlanResponse = try await APIClient.shared.patch(
                "/trip-planner/plans/\(viewModel.planId)/home", body: Body(clear: true))
            viewModel.replace(with: response)
            draft?.setHome(nil)
            original?.setHome(nil)
            await loadSuggestion()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    private func loadSuggestion() async {
        let response: TripTransitSuggestionResponse? = try? await APIClient.shared.get(
            "/trip-planner/plans/\(viewModel.planId)/transit-suggestion")
        guard let found = response?.suggestion,
              !UserDefaults.standard.bool(forKey: TripTransitSuggestion.dismissKey(
                planId: viewModel.planId, afterLegIndex: found.afterLegIndex))
        else {
            suggestion = nil
            return
        }
        suggestion = found
    }

    private func dismissSuggestion(_ found: TripTransitSuggestion) {
        UserDefaults.standard.set(true, forKey: TripTransitSuggestion.dismissKey(
            planId: viewModel.planId, afterLegIndex: found.afterLegIndex))
        suggestion = nil
    }
}
