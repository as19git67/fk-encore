import SwiftUI

/// The itinerary: the whole trip on one screen
/// (documentation/plans/reiseverlauf.md, and stage 2 of
/// documentation/plans/reise-planen-und-unterwegs.md).
///
/// A vertical line along which stays and journeys alternate. Under every
/// stay stand its days, each with a fill mark — free, half, full, too
/// much — so how big a stay is and where there is room shows at a
/// glance. The trip's name sits on top; a trip nobody named gets one
/// from the local model, and a tap changes it.
///
/// - A tap on a stay opens it for planning, a tap on one of its days
///   opens it at that day.
/// - A tap on a journey opens its sheet; a plus on the line adds a stay,
///   and the journey into it comes with it, times open. A plus on a ship
///   journey puts a port into it.
/// - Stays are reordered by dragging only while the trip has no date;
///   with a date the order makes the dates.
/// - A swipe to the left deletes a stay, with "Rückgängig".
///
/// Every sheet saves at once (`PUT …/itinerary`), so the screen never
/// holds unsaved changes: what it shows is the trip.
struct TripItineraryView: View {
    @State var viewModel: TripPlannerViewModel
    /// What to open, when the screen was entered from a leg or from one
    /// of the times a journey wrote on a day.
    var focus: TripItineraryFocus? = nil
    /// Set when the itinerary is the trip's own screen rather than a
    /// sheet over it: a stay or a day row then opens the stay's
    /// planning view through this, after selecting it, and there is no
    /// "Fertig".
    var onPlan: ((TripItineraryItem, Int?) -> Void)? = nil

    @Environment(\.dismiss) private var dismiss

    @State private var draft: TripItineraryDraft?
    @State private var loadError: String?
    @State private var errorMessage: String?
    @State private var saving = false
    @State private var sheet: ItinerarySheet?
    @State private var undo: UndoOffer?

    /// "Liste | Karte", remembered for the screen.
    @AppStorage("trip.itinerary.layout") private var layout = Layout.list.rawValue
    @State private var selectedStay: TripItineraryItem.ID?

    @State private var userHome: TripHome?
    /// The name the local model just proposed, said under the title
    /// while it is still the trip's name. Changed in the settings
    /// (suitcase › Einstellungen), never by a tap on the title.
    @State private var suggestedName: String?
    @State private var suggestingName = false

    /// The one journey the planner would suggest (§22.7), or nil.
    @State private var suggestion: TripTransitSuggestion?

    enum Layout: String { case list, map }

    private enum ItinerarySheet: Identifiable {
        case newStay(TripItineraryDraft, TripItineraryItem.ID)
        case stay(TripItineraryItem.ID)
        case journey(TripItineraryItem.ID)
        case port(TripItineraryItem.ID)
        case home

        var id: String {
            switch self {
            case .newStay(_, let id): return "new-\(id)"
            case .stay(let id): return "stay-\(id)"
            case .journey(let id): return "journey-\(id)"
            case .port(let id): return "port-\(id)"
            case .home: return "home"
            }
        }
    }

    /// What the last change can be taken back as.
    private struct UndoOffer: Equatable {
        let sentence: String
        let opId: Int
    }

    var body: some View {
        Group {
            if let draft {
                if layout == Layout.map.rawValue {
                    TripItineraryMapView(
                        draft: draft,
                        plan: viewModel.plan,
                        selected: $selectedStay,
                        onPlan: { stay, day in plan(stay, day: day) },
                    )
                } else {
                    list(draft)
                }
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
        .safeAreaInset(edge: .bottom) {
            if let undo {
                undoBar(undo)
            }
        }
        .toolbar {
            if onPlan == nil {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Fertig") { dismiss() }
                }
            }
            ToolbarItem(placement: .principal) {
                Picker("Ansicht", selection: $layout) {
                    Text("Liste").tag(Layout.list.rawValue)
                    Text("Karte").tag(Layout.map.rawValue)
                }
                .pickerStyle(.segmented)
                .fixedSize()
            }
            ToolbarItem(placement: .primaryAction) {
                if saving { ProgressView() }
            }
        }
        .sheet(item: $sheet) { which in
            NavigationStack {
                sheetContent(which)
            }
        }
        .task {
            if draft == nil { await load() }
            if userHome == nil { userHome = await TripUserHome.load() }
        }
    }

    // MARK: - The list

    private func list(_ draft: TripItineraryDraft) -> some View {
        let dated = draft.dated()
        let stays = draft.stays
        return List {
            header(draft)
                .listRowSeparator(.hidden)

            if let suggestion, let target = suggestionTarget(suggestion, in: draft) {
                suggestionRow(suggestion, target: target)
                    .listRowSeparator(.hidden)
            }

            plusRow(draft.outbound == nil ? "Aufenthalt am Anfang einfügen" : "Aufenthalt nach der Anreise einfügen",
                    isFirst: true) {
                startNewStay(after: nil, in: draft)
            }
            .disabled(!draft.canAddStay)

            if let outbound = draft.outbound, let at = draft.index(of: outbound.id) {
                journeyRow(outbound, dated: dated[at], in: draft)
            }

            ForEach(stays) { stay in
                stayRow(stay, in: draft, dated: dated)
            }
            .onMove(perform: mover(draft))

            if let last = draft.items.last, last.isJourney, draft.items.count > 1,
               let at = draft.index(of: last.id) {
                journeyRow(last, dated: dated[at], in: draft)
            }

            plusRow(draft.hasHome ? "Aufenthalt vor der Heimreise anhängen" : "Aufenthalt anhängen", isLast: true) {
                startNewStay(after: stays.last?.id, in: draft)
            }
            .disabled(!draft.canAddStay)

            homeRow
                .listRowSeparator(.hidden)

            let problems = draft.problems()
            if !problems.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(problems, id: \.self) { problem in
                        Label(problem, systemImage: "exclamationmark.circle")
                    }
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        // Every button on a row is its own target. A button in its
        // default style inside a list row fires on a tap anywhere in
        // the row.
        .buttonStyle(.borderless)
    }

    /// Dragging a stay, only while the trip has no date: with a date
    /// the order makes the dates (plan, "Reordering stays").
    private func mover(_ draft: TripItineraryDraft) -> ((IndexSet, Int) -> Void)? {
        guard draft.startDate == nil, draft.stayCount > 1 else { return nil }
        return { from, to in
            var next = draft
            next.moveStays(fromOffsets: from, toOffset: to)
            Task {
                if let refusal = await commit(next) { errorMessage = refusal }
            }
        }
    }

    // MARK: - Header: the name and the span

    private func header(_ draft: TripItineraryDraft) -> some View {
        let title = viewModel.plan?.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        // Only a label: the name is changed under the suitcase ›
        // Einstellungen (Anton, 10.11.), where the other settings of the
        // trip are, not by a tap that is easy to hit by accident.
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(title.isEmpty ? "Reise ohne Namen" : title)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(title.isEmpty ? .secondary : .primary)
                    .multilineTextAlignment(.leading)
                    .accessibilityAddTraits(.isHeader)
                if suggestingName { ProgressView() }
            }
            Text(TripItineraryText.tripSpan(draft))
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if let suggestedName, suggestedName == title {
                Text("Vorschlag · ändern in den Einstellungen")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Rows on the line

    /// The line and the node to the left of every row. Rows sit flush
    /// on top of each other, so the line runs through.
    private func onLine<Content: View>(node: TimelineNode, isFirst: Bool = false, isLast: Bool = false,
                                       @ViewBuilder _ content: () -> Content) -> some View {
        // The gutter is an overlay: an overlay is offered the row's full
        // height, so the line runs from top to bottom whatever the card.
        content()
            .padding(.vertical, 6)
            .padding(.leading, 36)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .leading) {
                TimelineGutter(node: node, isFirst: isFirst, isLast: isLast)
                    .padding(.leading, 2)
            }
            .padding(.horizontal, 16)
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
    }

    private func plusRow(_ label: String, isFirst: Bool = false, isLast: Bool = false,
                         action: @escaping () -> Void) -> some View {
        onLine(node: .plus, isFirst: isFirst, isLast: isLast) {
            Button(action: action) {
                Text(label)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(label)
        }
    }

    @ViewBuilder
    private func stayRow(_ stay: TripItineraryItem, in draft: TripItineraryDraft,
                         dated: [TripItineraryDated]) -> some View {
        let index = draft.index(of: stay.id) ?? 0
        let position = draft.stays.firstIndex { $0.id == stay.id } ?? 0
        VStack(spacing: 0) {
            // The journey into this stay from the one before; the way
            // there from home has its own row above.
            if position > 0, let before = draft.journey(before: stay.id) {
                journeyRow(before, dated: dated[index - 1], in: draft)
                // A plus on the ship puts a port in and splits the
                // voyage; the end of the trip stays (mock "Ablauf 3").
                if before.transportMode == .ship {
                    plusRow("Hafen in diese Fahrt einfügen") { sheet = .port(before.id) }
                        .disabled(!draft.canAddStay)
                }
            }
            onLine(node: .stay) {
                stayCard(stay, dated: dated[index], in: draft)
            }
            if position < draft.stayCount - 1 {
                plusRow("Aufenthalt einfügen") { startNewStay(after: stay.id, in: draft) }
                    .disabled(!draft.canAddStay)
            }
        }
        .listRowInsets(EdgeInsets())
        .listRowSeparator(.hidden)
        .swipeActions(edge: .trailing) {
            if draft.stayCount > 1 {
                Button(role: .destructive) {
                    remove(stay, in: draft)
                } label: {
                    Label("Entfernen", systemImage: "trash")
                }
            }
        }
        .swipeActions(edge: .leading) {
            Button {
                sheet = .stay(stay.id)
            } label: {
                Label("Bearbeiten", systemImage: "pencil")
            }
            .tint(.accentColor)
        }
        .contextMenu {
            Button {
                plan(stay, day: nil)
            } label: {
                Label("Planen", systemImage: "calendar")
            }
            Button {
                sheet = .stay(stay.id)
            } label: {
                Label("Bearbeiten", systemImage: "pencil")
            }
            if draft.startDate == nil, draft.stayCount > 1 {
                Button {
                    var next = draft
                    next.moveStay(id: stay.id, up: true)
                    Task { if let refusal = await commit(next) { errorMessage = refusal } }
                } label: {
                    Label("Nach oben", systemImage: "arrow.up")
                }
                .disabled(position == 0)
                Button {
                    var next = draft
                    next.moveStay(id: stay.id, up: false)
                    Task { if let refusal = await commit(next) { errorMessage = refusal } }
                } label: {
                    Label("Nach unten", systemImage: "arrow.down")
                }
                .disabled(position == draft.stayCount - 1)
            }
            if draft.stayCount > 1 {
                Button(role: .destructive) {
                    remove(stay, in: draft)
                } label: {
                    Label("Entfernen", systemImage: "trash")
                }
            }
        }
    }

    private func stayCard(_ stay: TripItineraryItem, dated: TripItineraryDated,
                          in draft: TripItineraryDraft) -> some View {
        let rows = dayRows(stay, dated: dated, in: draft)
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                plan(stay, day: nil)
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(draft.title(of: stay))
                            .font(.headline)
                            .foregroundStyle(.primary)
                        Spacer(minLength: 8)
                        Text(TripItineraryText.stayLength(days: stay.days ?? 1))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Text(staySubtitle(stay, dated: dated, in: draft))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Aufenthalt planen")

            ForEach(rows) { row in
                Divider().padding(.leading, 12)
                dayRow(row, stay: stay)
            }
        }
        .background(.background.secondary, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary))
    }

    private func dayRow(_ row: TripItineraryDayRow, stay: TripItineraryItem) -> some View {
        Button {
            plan(stay, day: row.dayIndex)
        } label: {
            HStack(spacing: 10) {
                Text(row.label)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Spacer(minLength: 6)
                Text(row.summary)
                    .font(.caption)
                    .foregroundStyle(row.isOverfull ? Color.red : Color.secondary)
                TripDayFillMark(fill: row.fill ?? 0)
                    .frame(width: 56)
                    .opacity(row.noTime ? 0 : 1)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 40)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Diesen Tag planen")
    }

    private func journeyRow(_ journey: TripItineraryItem, dated: TripItineraryDated,
                            in draft: TripItineraryDraft) -> some View {
        onLine(node: .journey) {
            Button {
                sheet = .journey(journey.id)
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: journey.transportMode.systemImage)
                        .foregroundStyle(.secondary)
                        .frame(width: 20)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(journeyLine(journey, in: draft))
                            .font(.subheadline)
                            .foregroundStyle(.primary)
                        if let nights = journey.nights, nights > 0 {
                            Text(nights == 1 ? "1 Nacht unterwegs" : "\(nights) Nächte unterwegs")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if let note = journey.note, !note.isEmpty {
                            Text(note)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 6)
                    if let shift = TripItineraryText.zoneShift(journey.zoneShiftMinutes) {
                        Text(shift)
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.quaternary, in: .capsule)
                            .accessibilityLabel("Zeitverschiebung \(shift)")
                    }
                    if let start = dated.startDate {
                        Text(TripItineraryText.shortDate(start))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(.quaternary,
                                      style: StrokeStyle(lineWidth: 1, dash: journey.isTimed ? [] : [5, 4])),
                )
            }
            .buttonStyle(.plain)
            .contextMenu {
                if journey.transportMode == .ship, draft.stay(before: journey.id) != nil,
                   draft.stay(after: journey.id) != nil {
                    Button {
                        sheet = .port(journey.id)
                    } label: {
                        Label("Hafen einfügen", systemImage: "plus.circle")
                    }
                }
            }
        }
    }

    private var homeRow: some View {
        Button {
            sheet = .home
        } label: {
            HStack {
                Label(viewModel.plan?.home.map { "Zuhause: \($0.displayLabel)" } ?? "Zuhause festlegen",
                      systemImage: "house")
                    .font(.subheadline)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .foregroundStyle(.secondary)
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Mit einem Zuhause stehen Anreise und Heimreise im Verlauf")
    }

    private func undoBar(_ offer: UndoOffer) -> some View {
        HStack {
            Text(offer.sentence)
                .font(.subheadline)
                .lineLimit(2)
            Spacer()
            Button("Rückgängig") { Task { await takeBack(offer) } }
                .fontWeight(.semibold)
            Button {
                undo = nil
            } label: {
                Image(systemName: "xmark")
            }
            .accessibilityLabel("Schließen")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.regularMaterial, in: .rect(cornerRadius: 14))
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    // MARK: - Words on the rows

    /// "Hotel Beispiel", "noch nichts gebucht", "an Bord", with the span.
    private func staySubtitle(_ stay: TripItineraryItem, dated: TripItineraryDated,
                              in draft: TripItineraryDraft) -> String {
        let offsets = TripItineraryText.dayOffsets(of: draft)
        let at = draft.index(of: stay.id) ?? 0
        var parts = [TripItineraryText.span(dated, dayOffsets: offsets[min(at, offsets.count - 1)])]
        if stay.anchor == nil {
            parts.append("noch kein Ort")
        } else if draft.isBetweenShips(stay.id) || stay.quartersAboard == true {
            parts.append("an Bord")
        } else if stay.anchorRadiusM != nil {
            parts.append("noch nichts gebucht")
        } else if let label = stay.anchorLabel, !label.isEmpty, label != draft.title(of: stay) {
            parts.append(label)
        }
        return parts.joined(separator: " · ")
    }

    /// "Anreise · Flug · ab 08:00 · an 12:30", "Schiff · Zeiten offen".
    private func journeyLine(_ journey: TripItineraryItem, in draft: TripItineraryDraft) -> String {
        var parts = [draft.name(of: journey)]
        if draft.name(of: journey) != "Schiff" {
            parts.append(TripJourneySheet.chipLabel(journey.transportMode))
        }
        switch (journey.departAt, journey.arriveAt) {
        case let (depart?, arrive?): parts.append("ab \(depart) · an \(arrive)")
        case let (depart?, nil): parts.append("ab \(depart)")
        case let (nil, arrive?): parts.append("an \(arrive)")
        case (nil, nil): parts.append("Zeiten offen")
        }
        return parts.joined(separator: " · ")
    }

    private func dayRows(_ stay: TripItineraryItem, dated: TripItineraryDated,
                         in draft: TripItineraryDraft) -> [TripItineraryDayRow] {
        let leg = stay.legId.flatMap { id in viewModel.plan?.legs.first { $0.id == id } }
        let arrival = draft.journey(before: stay.id)?.arriveAt ?? (draft.ownsStart(stay.id) ? stay.arriveAt : nil)
        let departure = draft.journey(after: stay.id)?.departAt
        return TripItineraryDays.rows(stay: stay, dated: dated, days: leg?.days ?? [], arrival: arrival, departure: departure)
    }

    // MARK: - The suggestion

    /// The journey the suggestion is about: the one after the leg at
    /// `afterLegIndex`, or the way there for −1. Only while that
    /// journey still has its times open.
    private func suggestionTarget(_ suggestion: TripTransitSuggestion,
                                  in draft: TripItineraryDraft) -> TripItineraryItem.ID? {
        let journey: TripItineraryItem?
        if suggestion.afterLegIndex < 0 {
            journey = draft.outbound
        } else {
            guard let leg = viewModel.plan?.legs.first(where: { $0.position == suggestion.afterLegIndex }),
                  let stay = draft.items.first(where: { $0.isStay && $0.legId == leg.id })
            else { return nil }
            journey = draft.journey(after: stay.id)
        }
        guard let journey, !journey.isTimed else { return nil }
        return journey.id
    }

    private func suggestionRow(_ suggestion: TripTransitSuggestion, target: TripItineraryItem.ID) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(suggestion.sentence, systemImage: "arrow.triangle.turn.up.right.diamond")
                .font(.subheadline)
            HStack {
                Button("Übernehmen") {
                    guard var next = draft, var journey = next[target] else { return }
                    journey.departAt = suggestion.departAt
                    journey.arriveAt = suggestion.arriveAt
                    journey.mode = suggestion.mode
                    if let from = suggestion.departDate, let to = suggestion.arriveDate,
                       let nights = TripCalendar.days(from: from, to: to) {
                        journey.nights = max(0, min(TripItineraryDraft.maxNights(for: journey.transportMode), nights))
                    }
                    next[target] = journey
                    self.suggestion = nil
                    Task { if let refusal = await commit(next) { errorMessage = refusal } }
                }
                .buttonStyle(.borderedProminent)
                Button("Nein") { dismissSuggestion(suggestion) }
                    .buttonStyle(.bordered)
            }
            .controlSize(.small)
        }
        .padding(12)
        .background(.quaternary.opacity(0.4), in: .rect(cornerRadius: 12))
    }

    // MARK: - Sheets

    @ViewBuilder
    private func sheetContent(_ which: ItinerarySheet) -> some View {
        switch which {
        case .newStay(let start, let id):
            TripStaySheet(draft: start, stayId: id, purpose: .new) { next in
                await commit(next)
            }
        case .stay(let id):
            if let draft, let stay = draft[id] {
                TripStaySheet(
                    draft: draft, stayId: id, purpose: .edit,
                    onCommit: { next in await commit(next, shortened: stay) },
                    onPlan: { plan(stay, day: nil) },
                    onRemove: { remove(stay, in: draft) },
                    onOpenJourney: { journeyId in openLater(.journey(journeyId)) },
                )
            }
        case .journey(let id):
            if let draft {
                TripJourneySheet(
                    draft: draft, journeyId: id,
                    onCommit: { next in await commit(next) },
                    onInsertPort: { journeyId in openLater(.port(journeyId)) },
                )
            }
        case .port(let id):
            if let draft {
                TripPortSheet(draft: draft, journeyId: id) { next in
                    await commit(next)
                }
            }
        case .home:
            TripHomeSheet(
                current: viewModel.plan?.home,
                userHome: userHome,
                onSet: { place in await setHome(place) },
                onClear: { await clearHome() },
            )
        }
    }

    /// Open another sheet once the one on screen has gone: a sheet that
    /// replaces itself in the same tick is not presented at all.
    private func openLater(_ next: ItinerarySheet) {
        Task {
            try? await Task.sleep(for: .milliseconds(450))
            sheet = next
        }
    }

    private func startNewStay(after stayId: TripItineraryItem.ID?, in draft: TripItineraryDraft) {
        var next = draft
        let id = next.insertStay(after: stayId)
        sheet = .newStay(next, id)
    }

    // MARK: - Planning a stay

    /// Back to the trip, on this stay and, when given, this day: the
    /// stay's planning view, or the day on its own screen.
    private func plan(_ stay: TripItineraryItem, day: Int?) {
        guard let legId = stay.legId,
              let leg = viewModel.plan?.legs.first(where: { $0.id == legId })
        else { return }
        viewModel.select(leg: leg.position)
        if let day { viewModel.select(dayIndex: day) }
        if let onPlan {
            onPlan(stay, day)
            return
        }
        // "Planen" on a stay and a day row both open the stay as a
        // whole (stage 3), a day row scrolled to its day.
        viewModel.wantsStayPlan = true
        dismiss()
    }

    // MARK: - Loading and saving

    private func load() async {
        loadError = nil
        do {
            let response: TripItineraryResponse = try await APIClient.shared.get(
                "/trip-planner/plans/\(viewModel.planId)/itinerary")
            let loaded = TripItineraryDraft(response: response)
            draft = loaded
            if viewModel.plan == nil { await viewModel.load() }
            if let focus, sheet == nil, let item = loaded.item(focused: focus) {
                sheet = item.isStay ? .stay(item.id) : .journey(item.id)
            }
            if selectedStay == nil { selectedStay = loaded.stays.first?.id }
            await loadSuggestion()
            await suggestNameIfNeeded()
        } catch {
            loadError = TripErrorText.describe(error)
        }
    }

    /// Save the whole chain at once and read it back. Answers nil when
    /// it was saved, otherwise the sentence the server refused it with.
    /// A stay that came back shorter than it was, while days of it were
    /// planned, can be taken back.
    private func commit(_ next: TripItineraryDraft, shortened before: TripItineraryItem? = nil) async -> String? {
        if let problem = next.problems().first { return problem }
        saving = true
        defer { saving = false }
        do {
            let response: TripPlanResponse = try await APIClient.shared.put(
                "/trip-planner/plans/\(viewModel.planId)/itinerary", body: next.request)
            viewModel.replace(with: response)
            errorMessage = nil
            undo = nil
            await reload()
            if let before, let after = next[before.id], (after.days ?? 1) < (before.days ?? 1) {
                await offerUndo("„\(next.title(of: after))“ ist kürzer geworden.")
            }
            return nil
        } catch {
            return TripErrorText.describe(error)
        }
    }

    private func reload() async {
        let response: TripItineraryResponse? = try? await APIClient.shared.get(
            "/trip-planner/plans/\(viewModel.planId)/itinerary")
        if let response {
            draft = TripItineraryDraft(response: response)
            if let selectedStay, draft?[selectedStay] == nil { self.selectedStay = draft?.stays.first?.id }
        }
    }

    private func remove(_ stay: TripItineraryItem, in draft: TripItineraryDraft) {
        var next = draft
        let name = draft.title(of: stay)
        next.removeStay(id: stay.id)
        Task {
            if let refusal = await commit(next) {
                errorMessage = refusal
            } else {
                await offerUndo("„\(name)“ entfernt.")
            }
        }
    }

    /// The newest itinerary change in the journal, offered back.
    private func offerUndo(_ sentence: String) async {
        let journal: TripJournal? = try? await APIClient.shared.get(
            "/trip-planner/plans/\(viewModel.planId)/ops", query: ["limit": "10"])
        guard let entry = journal?.entries.first(where: { $0.kind == "itinerary" && $0.undoable }) else { return }
        withAnimation { undo = UndoOffer(sentence: sentence, opId: entry.id) }
    }

    private func takeBack(_ offer: UndoOffer) async {
        saving = true
        defer { saving = false }
        do {
            let _: TripJournal = try await APIClient.shared.post(
                "/trip-planner/plans/\(viewModel.planId)/ops/undo", body: TripUndoRequest(opId: offer.opId))
            withAnimation { undo = nil }
            await viewModel.load()
            await reload()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    // MARK: - The name

    /// A trip nobody named gets a name from the local model, written
    /// only while it still has none (`POST …/name-suggestion`).
    private func suggestNameIfNeeded() async {
        let title = viewModel.plan?.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard title.isEmpty, !suggestingName else { return }
        suggestingName = true
        defer { suggestingName = false }
        struct Empty: Encodable {}
        struct Answer: Decodable {
            let title: String?
            let written: Bool
        }
        let answer: Answer? = try? await APIClient.shared.post(
            "/trip-planner/plans/\(viewModel.planId)/name-suggestion", body: Empty())
        if answer?.written == true {
            await viewModel.load()
            suggestedName = viewModel.plan?.title?.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    // MARK: - Home

    private func setHome(_ place: TripPlace) async {
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
            await reload()
            await loadSuggestion()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    private func clearHome() async {
        struct Body: Encodable { let clear: Bool }
        do {
            let response: TripPlanResponse = try await APIClient.shared.patch(
                "/trip-planner/plans/\(viewModel.planId)/home", body: Body(clear: true))
            viewModel.replace(with: response)
            await reload()
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

// MARK: - The line

enum TimelineNode {
    case stay, journey, plus
}

/// The column left of every row: the line, and on it a filled dot for a
/// stay, a ring for a journey, a plus where a stay can go in.
struct TimelineGutter: View {
    let node: TimelineNode
    var isFirst = false
    var isLast = false

    var body: some View {
        ZStack(alignment: .top) {
            VStack(spacing: 0) {
                Rectangle()
                    .fill(isFirst ? Color.clear : Color.secondary.opacity(0.3))
                    .frame(width: 2, height: 22)
                Rectangle()
                    .fill(isLast ? Color.clear : Color.secondary.opacity(0.3))
                    .frame(width: 2)
                    .frame(maxHeight: .infinity)
            }
            nodeView
                .padding(.top, node == .stay ? 14 : 13)
        }
        .frame(width: 24)
        .frame(maxHeight: .infinity, alignment: .top)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var nodeView: some View {
        switch node {
        case .stay:
            Circle().fill(Color.accentColor).frame(width: 14, height: 14)
        case .journey:
            Circle()
                .strokeBorder(Color.secondary.opacity(0.6), lineWidth: 1.5)
                .background(Circle().fill(Color(uiColor: .systemBackground)))
                .frame(width: 12, height: 12)
        case .plus:
            Image(systemName: "plus.circle")
                .font(.body)
                .foregroundStyle(.secondary)
                .background(Circle().fill(Color(uiColor: .systemBackground)))
                .frame(width: 18, height: 18)
        }
    }
}
