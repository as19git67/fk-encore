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
    /// The actions of a planned stop, from the one place that builds
    /// them (CLAUDE.md, "Aktionen an Spots"): a stop on the way of a
    /// journey is a planned stop like any other.
    var stopActions: ((TripStop) -> [TripPinSheetAction])? = nil

    @Environment(\.dismiss) private var dismiss

    @State private var draft: TripItineraryDraft?
    @State private var loadError: String?
    @State private var errorMessage: String?
    @State private var saving = false
    @State private var sheet: ItinerarySheet?
    /// The spot picker on a journey ("Halt hinzufügen"), and the leg
    /// the planner was on before, to go back to when it closes.
    @State private var stopsPick: StopsPick?
    @State private var stopsReturnTo: Int?
    /// A stop on the way whose details are open, over the itinerary.
    @State private var haltDetail: HaltPick?

    private struct HaltPick: Identifiable {
        let stop: TripStop
        let legId: Int
        var id: Int { stop.rowId }
    }

    private struct StopsPick: Identifiable {
        let legPosition: Int
        var id: Int { legPosition }
    }
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
                        onStop: { stop, leg in haltDetail = HaltPick(stop: stop, legId: leg.id) },
                        onJourney: { id in sheet = .journey(id) },
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
            .ownBackground()
            ToolbarItem(placement: .primaryAction) {
                if saving { ProgressView() }
            }
        }
        .sheet(item: $sheet) { which in
            NavigationStack {
                sheetContent(which)
            }
        }
        .sheet(item: $stopsPick, onDismiss: {
            if let back = stopsReturnTo { viewModel.select(leg: back) }
            stopsReturnTo = nil
        }) { _ in
            TripSpotPickerView(viewModel: viewModel)
        }
        .sheet(item: $haltDetail) { pick in
            haltDetailSheet(pick)
        }
        .task {
            if draft == nil { await load() }
            if userHome == nil { userHome = await TripUserHome.load() }
        }
        // A find added through the share sheet while this screen was
        // open: the model reloads itself, the chain here is our own copy.
        .onChange(of: viewModel.outsideChanges) { _, _ in
            Task { await reload() }
        }
        // Back online (the bar's "Neu laden"): the stored chain gives
        // way to the server's.
        .onChange(of: viewModel.offlineSince) { before, now in
            if before != nil, now == nil { Task { await reload() } }
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
                journeyWithStops(outbound, dated: dated[at], in: draft)
            }

            ForEach(stays) { stay in
                stayRow(stay, in: draft, dated: dated)
            }
            .onMove(perform: mover(draft))

            if let last = draft.items.last, last.isJourney, draft.items.count > 1,
               let at = draft.index(of: last.id) {
                journeyWithStops(last, dated: dated[at], in: draft)
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
                journeyWithStops(before, dated: dated[index - 1], in: draft)
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
        .contextMenu {
            if draft.stayCount > 1 {
                stayActions(stay, position: position, in: draft)
            }
        }
    }

    /// What one does with a stay (review F): move it, take it out. Its
    /// place, days and lodging are in its sheet, which a tap on the card
    /// opens; "Planen" is the button on the card itself and so not in
    /// the menu a second time (Anton, 17.11.). The "⋯" and a long press
    /// show these same entries — and both are left out on a trip with a
    /// single stay, which can be neither moved nor removed.
    @ViewBuilder
    private func stayActions(_ stay: TripItineraryItem, position: Int, in draft: TripItineraryDraft) -> some View {
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

    private func stayCard(_ stay: TripItineraryItem, dated: TripItineraryDated,
                          in draft: TripItineraryDraft) -> some View {
        let rows = dayRows(stay, dated: dated, in: draft)
        let position = draft.stays.firstIndex { $0.id == stay.id } ?? 0
        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 4) {
                // A tap opens the stay's sheet (review F): place, days,
                // arrival and departure, lodging.
                Button {
                    sheet = .stay(stay.id)
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(draft.title(of: stay))
                                .font(.headline)
                                .foregroundStyle(.primary)
                            if draft.startsFixed(stay.id) {
                                Image(systemName: "pin.fill")
                                    .font(.caption)
                                    .foregroundStyle(.orange)
                                    .accessibilityLabel("Beginn steht fest")
                            }
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
                .accessibilityHint("Ort, Tage und Unterkunft")

                Button("Planen") { plan(stay, day: nil) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .padding(.top, 10)
                    .padding(.trailing, draft.stayCount > 1 ? 0 : 12)
                if draft.stayCount > 1 {
                    Menu {
                        stayActions(stay, position: position, in: draft)
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.title3)
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(.rect)
                    }
                    .accessibilityLabel("Aktionen für \(draft.title(of: stay))")
                    .padding(.trailing, 4)
                }
            }

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
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(journeyLine(journey, in: draft))
                                .font(.subheadline)
                                .foregroundStyle(.primary)
                            if journey.isTicketed {
                                Image(systemName: "pin.fill")
                                    .font(.caption)
                                    .foregroundStyle(.orange)
                                    .accessibilityLabel("Termin steht fest")
                            }
                        }
                        if let nights = dated.item.nights, nights > 0 {
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
                    if let shift = TripItineraryText.zoneShiftBadge(journey.zoneShiftMinutes) {
                        Text(shift)
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.quaternary, in: .capsule)
                            .accessibilityLabel(TripItineraryText.zoneShiftSentence(journey.zoneShiftMinutes) ?? shift)
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

    // MARK: - Stops on the way, on the line

    /// A journey and, under it, its stops on the way — each on the line
    /// as a stay's days stand under the stay, and handled like a spot of
    /// an excursion: a tap opens its details, "⋯" acts, "+" adds one
    /// (Anton, 17.11.).
    @ViewBuilder
    private func journeyWithStops(_ journey: TripItineraryItem, dated: TripItineraryDated,
                                  in draft: TripItineraryDraft) -> some View {
        journeyRow(journey, dated: dated, in: draft)
        if let leg = stoppableLeg(of: journey) {
            ForEach(leg.stopsOnTheWay, id: \.rowId) { stop in
                haltRow(stop, leg: leg)
            }
            plusRow(leg.stopsOnTheWay.isEmpty ? "Halt unterwegs einplanen" : "Weiteren Halt einplanen") {
                pickStops(on: leg)
            }
            .disabled(viewModel.isOffline)
        }
    }

    private func haltRow(_ stop: TripStop, leg: TripLeg) -> some View {
        let fixed = TripItineraryStops.pin(of: stop, in: leg)
        let actions = stopActions?(stop) ?? []
        return onLine(node: .halt) {
            HStack(spacing: 4) {
                Button {
                    haltDetail = HaltPick(stop: stop, legId: leg.id)
                } label: {
                    HStack(spacing: 8) {
                        if fixed != nil {
                            Image(systemName: "pin.fill")
                                .font(.caption)
                                .foregroundStyle(Color.accentColor)
                                .accessibilityLabel("Feste Zeit")
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(TripSpotName.line(stop.displayName, local: stop.localName))
                                .font(.subheadline)
                                .foregroundStyle(.primary)
                                .strikethrough(stop.stopStatus == .skipped)
                                .lineLimit(2)
                            Text(TripItineraryStops.line(stop))
                                .font(.caption)
                                .foregroundStyle(stop.outsideHours == true ? Color.red : Color.secondary)
                        }
                        Spacer(minLength: 4)
                        if stop.stopStatus == .done {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                                .accessibilityLabel("Erledigt")
                        }
                    }
                    .padding(.leading, 12)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Details des Halts")
                if !actions.isEmpty {
                    Menu {
                        TripSpotActionMenuItems(actions: actions)
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.title3)
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(.rect)
                    }
                    .accessibilityLabel("Aktionen für \(stop.displayName)")
                    .padding(.trailing, 4)
                }
            }
            .background(.background.secondary, in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.quaternary))
            .contextMenu {
                if !actions.isEmpty { TripSpotActionMenuItems(actions: actions) }
            }
        }
    }

    /// The details of a stop on the way, leafing through the journey's
    /// stops — the same sheet a spot of a stay opens.
    @ViewBuilder
    private func haltDetailSheet(_ pick: HaltPick) -> some View {
        let leg = viewModel.plan?.legs.first { $0.id == pick.legId }
        TripSpotDetailPager(
            stops: leg?.stopsOnTheWay ?? [pick.stop],
            selected: pick.stop,
            mode: leg?.transportMode ?? .car,
            onSave: { edit in await viewModel.saveNote(edit, onLeg: leg?.position) },
            actions: stopActions ?? { _ in [] },
            onCategory: { osmRef, category in await viewModel.setCategory(osmRef: osmRef, category) },
            detailOf: { stop in TripItineraryStops.detail(stop, leg: leg) },
        )
    }

    /// The spot picker on the journey; the leg the planner was on comes
    /// back when it closes.
    private func pickStops(on leg: TripLeg) {
        stopsReturnTo = viewModel.legIndex
        viewModel.select(leg: leg.position)
        stopsPick = StopsPick(legPosition: leg.position)
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
                )
            }
        case .journey(let id):
            if let draft {
                TripJourneySheet(
                    draft: draft, journeyId: id,
                    onCommit: { next in await commit(next) },
                    onInsertPort: { journeyId in openLater(.port(journeyId)) },
                    stops: stoppableLeg(of: draft[id])?.stopsOnTheWay,
                    onAddStop: { next in await addStops(next, journeyId: id) },
                    onRemoveStop: { stop in await viewModel.returnToPool(stop) },
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

    // MARK: - Stops on the way

    /// The journey's own leg, when one can stop on it (`isStoppable`).
    private func stoppableLeg(of journey: TripItineraryItem?) -> TripLeg? {
        guard let legId = journey?.legId,
              let leg = viewModel.plan?.legs.first(where: { $0.id == legId }), leg.isStoppable
        else { return nil }
        return leg
    }

    /// "Halt hinzufügen": the chain is saved first, so the times just
    /// typed make the journey a leg with a day; then the spot picker
    /// opens on that leg, and the stay it was on comes back after.
    private func addStops(_ next: TripItineraryDraft, journeyId: TripItineraryItem.ID) async -> String? {
        guard let index = next.index(of: journeyId) else { return nil }
        if let refusal = await commit(next) { return refusal }
        guard let saved = draft?.items, saved.indices.contains(index),
              let leg = stoppableLeg(of: saved[index])
        else { return "Auf dieser Fahrt lassen sich keine Halte einplanen." }
        stopsReturnTo = viewModel.legIndex
        viewModel.select(leg: leg.position)
        Task {
            try? await Task.sleep(for: .milliseconds(450))
            stopsPick = StopsPick(legPosition: leg.position)
        }
        return nil
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
            show(response)
            if viewModel.plan == nil || viewModel.isOffline { await viewModel.load() }
            await loadSuggestion()
            await suggestNameIfNeeded()
        } catch let error where TripOfflineReach.meansUnreachable(error) {
            // No network: the trip opens on the chain it had when it was
            // stored for the road (§3.9). Without a stored copy there is
            // nothing to show, and the sentence says why.
            await viewModel.load()
            if let kept = viewModel.offlineItinerary {
                show(kept)
            } else {
                loadError = TripErrorText.describe(error)
            }
        } catch {
            loadError = TripErrorText.describe(error)
        }
    }

    private func show(_ response: TripItineraryResponse) {
        let loaded = TripItineraryDraft(response: response)
        draft = loaded
        if let focus, sheet == nil, let item = loaded.item(focused: focus) {
            sheet = item.isStay ? .stay(item.id) : .journey(item.id)
        }
        if selectedStay == nil { selectedStay = loaded.stays.first?.id }
    }

    /// Save the whole chain at once and read it back. Answers nil when
    /// it was saved, otherwise the sentence the server refused it with.
    /// A stay that came back shorter than it was, while days of it were
    /// planned, can be taken back.
    private func commit(_ next: TripItineraryDraft, shortened before: TripItineraryItem? = nil) async -> String? {
        if let problem = next.problems().first { return problem }
        if viewModel.isOffline { return TripPlannerViewModel.offlineText }
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
    case stay, journey, halt, plus
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
                .padding(.top, node == .stay ? 14 : node == .halt ? 22 : 13)
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
        case .halt:
            Circle().fill(Color.secondary.opacity(0.6)).frame(width: 8, height: 8)
        case .plus:
            Image(systemName: "plus.circle")
                .font(.body)
                .foregroundStyle(.secondary)
                .background(Circle().fill(Color(uiColor: .systemBackground)))
                .frame(width: 18, height: 18)
        }
    }
}

// MARK: - Stops on the way

/// How the itinerary and its map show a stop on the way of a journey.
enum TripItineraryStops {
    /// "ca. 11:20 · 45 min", or the duration while the time is unknown.
    static func line(_ stop: TripStop) -> String {
        var parts: [String] = []
        if let eta = stop.etaMinutes { parts.append("ca. \(TripClock.format(eta))") }
        parts.append(TripClock.duration(stop.dwellMinutes))
        return parts.joined(separator: " · ")
    }

    /// The fixed time that holds the stop at its hour, if any.
    static func pin(of stop: TripStop, in leg: TripLeg) -> TripFixpoint? {
        leg.days.flatMap(\.fixpoints).first { $0.isVisit && $0.spotRef == stop.osmRef }
    }

    /// The details: "Unterwegs · ca. 11:20 bis 12:05" rather than a day
    /// of a stay, and no distance from quarters the journey has not got.
    static func detail(_ stop: TripStop, leg: TripLeg?) -> TripSpotDetail {
        var detail = TripSpotDetail(stop)
        var planned = "Unterwegs"
        if let eta = stop.etaMinutes {
            planned += " · ca. \(TripClock.format(eta)) bis \(TripClock.format(eta + stop.dwellMinutes))"
        }
        detail.planned = planned
        if let leg, let fix = pin(of: stop, in: leg) {
            detail.pin = TripSpotDetailPin(reason: fix.reason, startMinutes: fix.startMinutes)
        }
        return detail
    }
}
