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
    /// A leg to open unfolded, when the screen was entered from one.
    var focusLegId: Int? = nil

    @Environment(\.dismiss) private var dismiss

    @State private var draft: TripItineraryDraft?
    /// What came from the server, to know whether anything changed.
    @State private var original: TripItineraryDraft?
    @State private var expanded: Set<TripItineraryItem.ID> = []
    @State private var loadError: String?
    @State private var errorMessage: String?
    @State private var isSaving = false
    @State private var confirmCancel = false
    @State private var removing: TripItineraryItem?

    /// One place search for the whole screen: only one stay looks for
    /// its lodging at a time.
    @State private var placeFinder = TripPlaceFinderModel()
    @State private var searchingPlaceFor: TripItineraryItem.ID?

    /// Looking for where home is (§22.7), and what the person said in
    /// the settings, for the trip made before it was known.
    @State private var homeFinder = TripPlaceFinderModel()
    @State private var userHome: TripHome?
    @State private var savingHome = false

    /// The one journey the planner would suggest (§22.7), or nil.
    @State private var suggestion: TripTransitSuggestion?

    /// A port day being sent ashore (§21.3): which leg, which day.
    @State private var anchorTarget: AnchorTarget?
    private struct AnchorTarget: Identifiable {
        let legPosition: Int
        let dayIndex: Int
        let label: String
        let current: TripDayAnchor?
        var id: String { "\(legPosition)-\(dayIndex)" }
    }

    private var isDirty: Bool { draft != nil && draft != original }

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
            ToolbarItemGroup(placement: .topBarTrailing) {
                if (draft?.stayCount ?? 0) > 1 {
                    EditButton()
                }
                Button {
                    Task { await save() }
                } label: {
                    if isSaving { ProgressView() } else { Text("Sichern") }
                }
                .disabled(isSaving || !isDirty || !(draft?.problems().isEmpty ?? false))
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
        .sheet(item: $anchorTarget) { target in
            TripDayAnchorSheet(dayLabel: target.label, current: target.current) { anchorDraft in
                viewModel.select(leg: target.legPosition)
                viewModel.select(dayIndex: target.dayIndex)
                await viewModel.setDayAnchor(anchorDraft)
            }
        }
        .task {
            await load()
            userHome = await TripUserHome.load()
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
                    .moveDisabled(stays.count < 2)
                    .deleteDisabled(stays.count < 2)
                    .swipeActions(edge: .trailing) {
                        if stays.count > 1 {
                            Button(role: .destructive) { removing = stay } label: {
                                Label("Entfernen", systemImage: "trash")
                            }
                        }
                    }
                }
                .onMove { from, to in
                    self.draft?.moveStays(fromOffsets: from, toOffset: to)
                }
                .onDelete { offsets in
                    guard let first = offsets.first, stays.indices.contains(first) else { return }
                    removing = stays[first]
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
                let newId = self.draft?.insertStay(after: previous)
                if let newId {
                    expanded.insert(newId)
                    searchingPlaceFor = newId
                    placeFinder.query = ""
                    placeFinder.clearResults()
                }
            } label: {
                Image(systemName: "plus.circle.fill")
                    .font(.title3)
                    .foregroundStyle(.tint)
            }
            .buttonStyle(.borderless)
            .disabled(!draft.canAddStay)
            .accessibilityLabel("Aufenthalt hier einfügen")
            Rectangle().fill(.quaternary).frame(height: 1)
        }
        .padding(.vertical, 2)
    }

    private func addStayRow(_ draft: TripItineraryDraft) -> some View {
        Button {
            let newId = self.draft?.insertStay(after: draft.stays.last?.id)
            if let newId {
                expanded.insert(newId)
                searchingPlaceFor = newId
                placeFinder.query = ""
                placeFinder.clearResults()
            }
        } label: {
            Label("Aufenthalt hinzufügen", systemImage: "plus.circle")
        }
        .disabled(!draft.canAddStay)
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
                stayFields(stay, in: draft)
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.4), in: .rect(cornerRadius: 12))
    }

    @ViewBuilder
    private func stayFields(_ stay: TripItineraryItem, in draft: TripItineraryDraft) -> some View {
        let item = binding(stay.id)
        Divider()
        TextField("Name (optional)", text: Binding(
            get: { item.wrappedValue.title ?? "" },
            set: { item.wrappedValue.title = $0 },
        ))
        .textInputAutocapitalization(.words)

        // The lodging: where every day starts and ends (§4.2).
        if let place = stay.place, searchingPlaceFor != stay.id {
            HStack {
                Label(place.name, systemImage: "mappin.circle.fill").lineLimit(2)
                Spacer()
                Button("Ändern") {
                    searchingPlaceFor = stay.id
                    placeFinder.query = place.name
                    placeFinder.clearResults()
                }
                .buttonStyle(.borderless)
            }
        } else {
            TripPlaceFinderRows(model: placeFinder, picked: nil) { place in
                item.wrappedValue.place = place
                placeFinder.clearResults()
                searchingPlaceFor = nil
            }
            if stay.place != nil {
                Button("Ort behalten") { searchingPlaceFor = nil }
                    .buttonStyle(.borderless)
            }
        }
        Text("Hotel, Campingplatz oder Adresse — hier fängt jeder Tag an und hier endet er. "
             + "Eine Stadt geht auch; dann plant der Planer um deren Mitte herum.")
            .font(.caption2)
            .foregroundStyle(.secondary)

        Toggle("Noch nichts gebucht", isOn: Binding(
            get: { item.wrappedValue.anchorRadiusM != nil },
            set: { on in item.wrappedValue.anchorRadiusM = on ? (item.wrappedValue.anchorRadiusM ?? 1_000) : nil },
        ))
        if stay.anchorRadiusM != nil {
            TripRadiusPicker(metres: Binding(
                get: { item.wrappedValue.anchorRadiusM ?? 1_000 },
                set: { item.wrappedValue.anchorRadiusM = $0 },
            ))
        }

        Stepper(value: Binding(
            get: { item.wrappedValue.days ?? 1 },
            set: { item.wrappedValue.days = $0 },
        ), in: TripItineraryDraft.minStayDays...TripItineraryDraft.maxStayDays) {
            Text(TripItineraryText.stayLength(days: stay.days ?? 1))
        }

        TripTransportModePicker(mode: Binding(
            get: { item.wrappedValue.transportMode },
            set: { newMode in
                var updated = item.wrappedValue
                // A radius still at the old mode's default follows the
                // mode; one somebody set stays.
                if let current = updated.radiusM {
                    updated.radiusM = TripReach.radius(movingFrom: updated.transportMode, to: newMode, current: current)
                }
                updated.transportMode = newMode
                item.wrappedValue = updated
            },
        ))

        Toggle("Unterkunft fährt mit", isOn: Binding(
            get: { item.wrappedValue.quartersAboard ?? false },
            set: { on in
                item.wrappedValue.quartersAboard = on
                if !on { item.wrappedValue.tenderPort = false }
            },
        ))
        if stay.quartersAboard == true {
            Toggle("Tenderhafen", isOn: Binding(
                get: { item.wrappedValue.tenderPort ?? false },
                set: { item.wrappedValue.tenderPort = $0 },
            ))
            Text("Die Unterkunft ist der Liegeplatz, und die Abfahrt heißt „Alle an Bord“ mit einer "
                 + "Stunde Puffer — in einem Tenderhafen anderthalb. Jeder Tag kann in einen anderen "
                 + "Hafen gehen; ohne Hafen ist es ein Seetag.")
                .font(.caption2)
                .foregroundStyle(.secondary)
            portDays(stay, in: draft)
        }

        if draft.stayCount > 1 {
            Button(role: .destructive) {
                removing = stay
            } label: {
                Label("Aufenthalt entfernen", systemImage: "trash")
            }
            .buttonStyle(.borderless)
        }
    }

    /// The days of a stay aboard (§21.3), each with its port, or the
    /// plain fact that it is a sea day. Only for a stay the server has:
    /// a new one has no days to send ashore yet.
    @ViewBuilder
    private func portDays(_ stay: TripItineraryItem, in draft: TripItineraryDraft) -> some View {
        if let leg = viewModel.plan?.legs.first(where: { $0.id == stay.legId }) {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(leg.days) { day in
                    Button {
                        anchorTarget = AnchorTarget(
                            legPosition: leg.position, dayIndex: day.dayIndex,
                            label: "Tag \(day.dayIndex + 1)", current: day.anchor)
                    } label: {
                        HStack {
                            Text("Tag \(day.dayIndex + 1)")
                            if let date = leg.date(ofDayIndex: day.dayIndex) {
                                Text(date).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(day.anchor?.summary ?? "Seetag")
                                .foregroundStyle(day.anchor == nil ? .secondary : .primary)
                                .lineLimit(1)
                            Image(systemName: "chevron.right")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        .font(.subheadline)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 4)
        } else {
            Text("Die Häfen lassen sich eintragen, sobald der Aufenthalt gesichert ist.")
                .font(.caption2)
                .foregroundStyle(.secondary)
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
                journeyFields(journey)
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
        optionalTime("Ankunft", clock: Binding(
            get: { item.wrappedValue.arriveAt },
            set: { item.wrappedValue.arriveAt = $0 },
        ), defaultMinutes: 16 * 60)
        Stepper(value: Binding(
            get: { item.wrappedValue.nights ?? 0 },
            set: { item.wrappedValue.nights = $0 },
        ), in: 0...TripItineraryDraft.maxJourneyNights) {
            let nights = journey.nights ?? 0
            Text(nights == 0 ? "Ankunft am selben Tag" : nights == 1 ? "1 Nacht unterwegs" : "\(nights) Nächte unterwegs")
        }
        TripTransportModePicker(mode: Binding(
            get: { item.wrappedValue.transportMode },
            set: { item.wrappedValue.transportMode = $0 },
        ), choices: TripTransportMode.allCases)
        Text(Self.journeyHint(journey))
            .font(.caption2)
            .foregroundStyle(.secondary)
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
        }
    }

    /// A time that may simply not be known yet. A `DatePicker` cannot
    /// say "unknown", and midnight would be a departure nobody said
    /// (§15.3) — so the toggle carries the knowledge and the picker
    /// only the hour.
    @ViewBuilder
    private func optionalTime(_ label: String, clock: Binding<String?>, defaultMinutes: Int) -> some View {
        Toggle(label, isOn: Binding(
            get: { clock.wrappedValue != nil },
            set: { on in clock.wrappedValue = on ? (clock.wrappedValue ?? TripClock.format(defaultMinutes)) : nil },
        ))
        if let current = clock.wrappedValue {
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

    // MARK: - Loading and saving

    private func load() async {
        loadError = nil
        do {
            let response: TripItineraryResponse = try await APIClient.shared.get(
                "/trip-planner/plans/\(viewModel.planId)/itinerary")
            let loaded = TripItineraryDraft(response: response)
            draft = loaded
            original = loaded
            if let focusLegId, let item = loaded.items.first(where: { $0.legId == focusLegId }) {
                expanded.insert(item.id)
            }
            if viewModel.plan == nil { await viewModel.load() }
            await loadSuggestion()
        } catch {
            loadError = TripErrorText.describe(error)
        }
    }

    private func save() async {
        guard let draft, draft.problems().isEmpty else { return }
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
