import CoreLocation
import MapKit
import SwiftUI
import UniformTypeIdentifiers

/// A stay planned as a whole (reise-planen-und-unterwegs.md, stage 3):
/// every day of it on one screen, each with what it holds as cards —
/// picture, name, estimated time, duration, priority, a fixed time with
/// its reason — and "verplant von verfügbar" in its header.
///
/// A card is dragged onto another card to stand before it, or onto a
/// day to go to its end; an empty day is a drop zone of its own. The
/// "⋯" on a card holds the same actions as the day's rows, the map's
/// sheet and the detail screen (CLAUDE.md, "Aktionen an Spots"); a tap
/// opens the details. "Tage | Karte" (top right) shows the same days on
/// a map with day chips.
struct TripStayPlanView: View {
    @State var viewModel: TripPlannerViewModel
    /// The actions of a stop, from the one place that builds them.
    let stopActions: (TripStop) -> [TripPinSheetAction]
    /// What a day's "⋯" does (order, a break, a fixed time, a day trip):
    /// the host owns those sheets. A day has no screen of its own any
    /// more (Anton, 10.11.).
    let dayAction: (TripStayDayAction, Int) -> Void
    /// The screen's title when it is the trip's first screen (the
    /// trip's name); otherwise the stay's.
    var title: String? = nil

    /// "Tage | Karte", remembered for the screen (mock "Mit der Karte":
    /// every view has its map).
    @AppStorage("trip.stayPlan.layout") private var layout = Layout.list.rawValue
    /// The day the map shows numbered; nil is every day.
    @State private var mapDay: Int?
    @State private var showIdeasOnMap = true
    /// The marker tapped on the map, for its "+ Tag n".
    @State private var picked: TripStayMapPick?
    /// What a button of the marker's sheet opens once that sheet is gone.
    @State private var afterPin: (() -> Void)?
    /// The hour the map's slider is at; nil until it is moved.
    @State private var sliderMinutes: Int?
    /// The card being dragged, so the day it hovers over can say so.
    /// Where a dragged card would land: the day, and the card it would
    /// go in front of (nil is the end of the day). Drawn as a line.
    @State private var dropSlot: TripDropSlot?
    /// The card whose details are open, as a sheet over the days (stage 4).
    @State private var detailPick: TripStayDetailPick?
    /// When a card was last swiped sideways: the lift of that finger
    /// also ends the card's tap, which must not open its details.
    @State private var swipedAt: Date?
    /// The spot picker (stage 4) and where it was opened from. One value
    /// rather than a flag beside the origin: a sheet that reads state only
    /// inside its content can build from the values before the tap, and
    /// then "+ Spot in Seestadt" opened on the stay.
    @State private var picking: TripPickerRequest?
    /// Two excursions about to go on from each other (Mock 18 B).
    @State private var linking: TripExcursionLink?
    /// The excursion whose removal is being confirmed.
    @State private var removingExcursion: TripExcursionPick?
    /// Days that are over, opened from their one line (stage 5).
    @State private var expandedPast: Set<Int> = []
    /// The done stop whose check mark was tapped: "Nicht besucht"?
    @State private var unchecking: TripStop?
    /// Missed stops already answered ("Lassen"), by row id, so the
    /// question comes once (stage 5).
    @AppStorage("trip.stayPlan.missedAnswered") private var missedAnswered = ""
    /// The sheet "Weg" (stage 6).
    @State private var wayRequest: TripWayRequest?
    /// Rain over a day with spots outdoors (stage 7, step 1).
    @State private var weatherNotes: [TripWeatherNote] = []
    /// The note whose "Tage tauschen?" sheet is open.
    @State private var swapping: TripWeatherNote?
    /// The day whose note is being applied.
    @State private var applyingNote: Int?
    /// The last weather move, offered back.
    @State private var undo: WeatherUndo?
    /// The sheet "Aufenthalt" with place, days and lodging, opened from
    /// the head of the days or the title's menu.
    @State private var editingStay: TripStayEditing?
    /// "Tag füllen" or "Alle Tage füllen", whose sheet is open (stage 8).
    @State private var fillRequest: TripFillRequest?
    /// "n weitere anzeigen" under the open spots.
    @State private var showAllOpen = false

    private enum Layout: String { case list, map }

    private struct WeatherUndo: Equatable {
        let sentence: String
        let opId: Int
    }


    var body: some View {
        Group {
            if let leg = viewModel.leg {
                if layout == Layout.map.rawValue {
                    map(leg)
                } else {
                    list(leg)
                }
            } else {
                ContentUnavailableView("Kein Aufenthalt", systemImage: "map")
            }
        }
        .task(id: viewModel.leg.map(diaryKey)) {
            if let leg = viewModel.leg { await loadDayData(leg) }
        }
        .task(id: viewModel.leg.map(notesKey)) {
            weatherNotes = await TripWeatherAPI.notes(planId: viewModel.planId, legIndex: viewModel.legIndex)
        }
        .safeAreaInset(edge: .bottom) {
            if let undo { undoBar(undo) }
        }
        .navigationTitle(title ?? viewModel.leg?.displayTitle ?? "Aufenthalt")
        .navigationBarTitleDisplayMode(.inline)
        // Only the stay's own data: "Bearbeiten" would not say that the
        // spots and excursions are edited elsewhere (Anton, 11.11.).
        .toolbarTitleMenu {
            Button("Ort, Tage und Unterkunft …", systemImage: "info.circle") {
                Task { await openStay() }
            }
        }
        .sheet(item: $fillRequest) { request in
            TripDayFillSheet(planId: viewModel.planId, legIndex: viewModel.legIndex, request: request) { days in
                await acceptFill(days, fromMinutes: request.fromMinutes)
            }
        }
        .sheet(item: $editingStay) { editing in
            TripStaySheet(draft: editing.draft, stayId: editing.id, purpose: .edit,
                          onCommit: { next in await commitStay(next) })
        }
        .toolbar {
            // A sign that the server is working, so a change that takes a
            // moment is not mistaken for one that did nothing.
            if viewModel.isWorking {
                ToolbarItem(placement: .primaryAction) {
                    ProgressView()
                        .accessibilityLabel("Wird geladen")
                }
            }
            ToolbarItem(placement: .primaryAction) {
                Picker("Ansicht", selection: $layout) {
                    Text("Tage").tag(Layout.list.rawValue)
                    Text("Karte").tag(Layout.map.rawValue)
                }
                .pickerStyle(.segmented)
                .fixedSize()
            }
            .ownBackground()
            // The days have their own big button; the map keeps the plus.
            if layout == Layout.map.rawValue {
                ToolbarItem(placement: .primaryAction) {
                    Button("Ideen und Suche", systemImage: "plus") { picking = TripPickerRequest() }
                }
            }
        }
        .sheet(item: $linking) { link in
            TripExcursionLinkSheet(link: link, stayTitle: viewModel.leg?.displayTitle ?? "Unterkunft") {
                await viewModel.linkExcursion(link.next, after: link.last, dayIndex: link.dayIndex)
            }
        }
        .sheet(item: $picking) { request in
            TripSpotPickerView(viewModel: viewModel, dayTrip: request.dayTrip,
                               excursion: request.excursion.map { ($0.dayIndex, $0.excursion) },
                               day: request.day)
        }
        .confirmationDialog(removingExcursion.map { "\($0.excursion.title) entfernen?" } ?? "",
                            isPresented: Binding(get: { removingExcursion != nil },
                                                 set: { if !$0 { removingExcursion = nil } }),
                            titleVisibility: .visible) {
            Button("Ausflug entfernen", role: .destructive) {
                guard let pick = removingExcursion else { return }
                Task { await viewModel.removeExcursion(pick.excursion, dayIndex: pick.dayIndex) }
            }
        } message: {
            Text("Seine Spots gehen zurück zu den Ideen.")
        }
        .sheet(item: $detailPick) { pick in
            TripSpotDetailPager(
                stops: viewModel.leg?.days.first(where: { $0.dayIndex == pick.dayIndex })
                    .map(TripStayPlan.stops(of:)) ?? [pick.stop],
                selected: pick.stop,
                mode: viewModel.leg?.transportMode ?? .foot,
                onSave: { await viewModel.saveNote($0) },
                actions: stopActions,
                way: { stop in
                    guard let leg = viewModel.leg,
                          let day = leg.days.first(where: { $0.dayIndex == pick.dayIndex }) else { return nil }
                    return AnyView(TripWaySheet(viewModel: viewModel,
                                                request: makeWayRequest(to: stop, on: day, leg: leg, fromHere: false),
                                                stayMode: leg.transportMode))
                },
                stayLight: { stop in
                    TripStayLightRef(planId: viewModel.planId, legIndex: viewModel.legIndex,
                                     osmRef: stop.osmRef, startDate: viewModel.leg?.startDate)
                },
                onStayLightAccepted: { await viewModel.load() },
                onCategory: { osmRef, category in await viewModel.setCategory(osmRef: osmRef, category) },
                detailOf: { stop in
                    TripSpotDetailContext.detail(stop, dayIndex: pick.dayIndex, leg: viewModel.leg,
                                                 pin: viewModel.visit(holding: stop, onDay: pick.dayIndex))
                },
            )
        }
        .sheet(item: $swapping) { note in
            if let leg = viewModel.leg {
                TripWeatherSwapSheet(note: note, leg: leg) {
                    Task { await applyNote(note, kind: "swap") }
                }
            }
        }
        .sheet(item: $wayRequest) { request in
            TripWaySheet(viewModel: viewModel, request: request,
                         stayMode: viewModel.leg?.transportMode ?? .foot)
        }
        .confirmationDialog(unchecking?.displayName ?? "", isPresented: Binding(
            get: { unchecking != nil },
            set: { if !$0 { unchecking = nil } },
        ), titleVisibility: .visible) {
            if let stop = unchecking {
                Button(stop.stopStatus == .done ? "Nicht besucht" : "Doch wieder offen") {
                    Task { await viewModel.mark(stop, as: .planned) }
                }
            }
        }
        .plannerErrorBanner(viewModel.errorMessage, retry: { await viewModel.load() },
                            dismiss: { viewModel.errorMessage = nil })
    }

    // MARK: - Weather

    /// What the notes depend on: the stay and which spot is on which day.
    private func notesKey(_ leg: TripLeg) -> String {
        let today = TripCalendar.isoDay(Date())
        let days = leg.days.map { day in "\(day.dayIndex):\(TripStayPlan.stops(of: day).map(\.osmRef))" }
        return "\(viewModel.legIndex)|\(today)|\(days)"
    }

    private func applyNote(_ note: TripWeatherNote, kind: String) async {
        applyingNote = note.dayIndex
        defer { applyingNote = nil }
        do {
            let response = try await TripWeatherAPI.apply(planId: viewModel.planId, legIndex: viewModel.legIndex,
                                                          dayIndex: note.dayIndex, kind: kind)
            await viewModel.load()
            withAnimation { undo = WeatherUndo(sentence: response.sentence, opId: response.opId) }
        } catch {
            viewModel.errorMessage = TripErrorText.describe(error)
        }
    }

    private func undoBar(_ offer: WeatherUndo) -> some View {
        HStack {
            Text(offer.sentence)
                .font(.subheadline)
                .lineLimit(2)
            Spacer()
            Button("Rückgängig") {
                Task {
                    do {
                        try await TripWeatherAPI.undo(planId: viewModel.planId, opId: offer.opId)
                        withAnimation { undo = nil }
                        await viewModel.load()
                    } catch {
                        viewModel.errorMessage = TripErrorText.describe(error)
                    }
                }
            }
            .fontWeight(.semibold)
            Button {
                withAnimation { undo = nil }
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

    // MARK: - List

    private func list(_ leg: TripLeg) -> some View {
        TimelineView(.everyMinute) { context in
            list(leg, now: context.date)
        }
    }

    /// What the diaries and forecasts depend on: the stay, its days and
    /// what is ticked off on them.
    private func diaryKey(_ leg: TripLeg) -> String {
        let today = TripCalendar.isoDay(Date())
        let done = leg.days.flatMap(TripStayPlan.stops(of:)).filter { $0.stopStatus != .planned }.map(\.rowId)
        return "\(viewModel.legIndex)|\(today)|\(leg.days.map(\.dayIndex))|\(done)"
    }

    /// Weather and photos of the days that are over or being lived,
    /// and the forecast of the days it reaches.
    private func loadDayData(_ leg: TripLeg) async {
        let today = TripCalendar.isoDay(Date())
        for day in days(of: leg) {
            let phase = TripOnTheRoad.phase(of: day.dayIndex, in: leg, today: today)
            if phase == .past || phase == .running { await viewModel.loadDiary(dayIndex: day.dayIndex) }
            if phase != .past, TripOnTheRoad.hasForecast(day.dayIndex, in: leg, today: today),
               viewModel.stayForecast(dayIndex: day.dayIndex) == nil {
                await viewModel.loadStayForecast(dayIndex: day.dayIndex)
            }
        }
    }

    private func list(_ leg: TripLeg, now: Date) -> some View {
        let today = TripCalendar.isoDay(now)
        let nowMinutes = TripDayTimeline.minutesOfDay(now)
        let running = leg.days.first { TripOnTheRoad.phase(of: $0.dayIndex, in: leg, today: today) == .running }
        return ScrollViewReader { proxy in
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                stayHeader(leg, running: running, nowMinutes: nowMinutes)
                if running == nil { openSection(leg) }
                ForEach(days(of: leg)) { day in
                    let phase = TripOnTheRoad.phase(of: day.dayIndex, in: leg, today: today)
                    Group {
                        if phase == .past && !expandedPast.contains(day.dayIndex) {
                            pastLine(day, leg: leg, today: today)
                        } else {
                            daySection(day, leg: leg, phase: phase, now: now, nowMinutes: nowMinutes, today: today)
                        }
                    }
                    .id(day.dayIndex)
                }
                // On the road the day comes first and the search after it.
                if running != nil { ideasButton(leg) }
            }
            .padding(16)
        }
        .background(Color(.systemGroupedBackground))
        // On the road the stay opens on the day being lived; from a day
        // row of the itinerary, on that day.
        .onAppear {
            if let running {
                proxy.scrollTo(running.dayIndex, anchor: .top)
            } else if viewModel.dayIndex > 0 {
                proxy.scrollTo(viewModel.dayIndex, anchor: .top)
            }
        }
        }
    }

    /// The stay's name and what it is: its days and lodging, or on the
    /// road which day it is and the weather now.
    private func stayHeader(_ leg: TripLeg, running: TripDay?, nowMinutes: Int) -> some View {
        Button {
            Task { await openStay() }
        } label: {
            HStack(alignment: .center, spacing: 12) {
                stayHeaderText(leg, running: running)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Ort, Tage und Unterkunft")
        .accessibilityAddTraits(.isHeader)
    }

    private func stayHeaderText(_ leg: TripLeg, running: TripDay?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(leg.displayTitle)
                .font(.title2.weight(.bold))
            if let running {
                HStack(spacing: 6) {
                    Text("Tag \(running.dayIndex + 1) von \(leg.days.count) · heute")
                    if let weather = viewModel.stayForecast(dayIndex: running.dayIndex)?.overall {
                        Label(weather.summary, systemImage: weather.symbolName)
                            .labelStyle(.titleAndIcon)
                    }
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
            } else {
                Text(TripStayPlan.staySubtitle(leg))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .multilineTextAlignment(.leading)
    }

    /// The itinerary as it is now, with this stay picked, for its sheet.
    private func openStay() async {
        guard let legId = viewModel.leg?.id else { return }
        do {
            let response: TripItineraryResponse = try await APIClient.shared.get(
                "/trip-planner/plans/\(viewModel.planId)/itinerary")
            let draft = TripItineraryDraft(response: response)
            guard let stay = draft.items.first(where: { $0.isStay && $0.legId == legId }) else { return }
            editingStay = TripStayEditing(id: stay.id, draft: draft)
        } catch {
            viewModel.errorMessage = TripErrorText.describe(error)
        }
    }

    /// Saved like from the itinerary: the whole chain, read back.
    private func commitStay(_ next: TripItineraryDraft) async -> String? {
        if let problem = next.problems().first { return problem }
        do {
            let response: TripPlanResponse = try await APIClient.shared.put(
                "/trip-planner/plans/\(viewModel.planId)/itinerary", body: next.request)
            viewModel.replace(with: response)
            return nil
        } catch {
            return TripErrorText.describe(error)
        }
    }

    /// The day's "⋯": what used to live on the day's own screen.
    private func dayMenu(_ day: TripDay, leg: TripLeg, hasStops: Bool) -> some View {
        Menu {
            Button {
                dayAction(.order, day.dayIndex)
            } label: {
                Label("Reihenfolge vorschlagen", systemImage: "arrow.triangle.swap")
            }
            .disabled(!hasStops)
            Menu {
                ForEach(TripBreakPreset.allCases) { preset in
                    Button {
                        dayAction(.pause(preset), day.dayIndex)
                    } label: {
                        Label("\(preset.label) · \(TripClock.duration(preset.minutes))", systemImage: preset.symbolName)
                    }
                }
            } label: {
                Label("Pause einfügen", systemImage: "pause.circle")
            }
            Button {
                dayAction(.fixedTime, day.dayIndex)
            } label: {
                Label("Feste Zeit eintragen", systemImage: "clock.badge.exclamationmark")
            }
            Button {
                dayAction(.dayTrip, day.dayIndex)
            } label: {
                Label(day.anchor == nil ? "Ausflug hinzufügen" : "Ausflug ändern", systemImage: "car")
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.body)
                .frame(minWidth: 44, minHeight: 32)
                .contentShape(.rect)
        }
        .accessibilityLabel("Aktionen für \(TripStayPlan.dayHeading(day, leg: leg))")
    }

    /// What the day is planned around besides its spots: fixed times
    /// without a spot (a spot's own time stands on its card), the
    /// breaks, and what "Reihenfolge vorschlagen" said about an overfull
    /// day. Each with its way to take it off.
    @ViewBuilder
    private func dayFrame(_ day: TripDay, leg: TripLeg) -> some View {
        let free = day.fixpoints.filter { $0.spotRef == nil && !leg.isJourneyDeparture($0, dayIndex: day.dayIndex) }
        let breaks = day.breaks ?? []
        if !free.isEmpty || !breaks.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(free) { fix in
                    HStack(spacing: 10) {
                        Image(systemName: "clock")
                            .foregroundStyle(.orange)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(fix.label)
                            Text(TripClock.format(fix.startMinutes)
                                 + (fix.durationMinutes > 0 ? " · \(TripClock.duration(fix.durationMinutes))" : ""))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button(role: .destructive) {
                            Task { await viewModel.removeFixpoint(fix) }
                        } label: {
                            Image(systemName: "xmark.circle")
                        }
                        .buttonStyle(.borderless)
                        .disabled(viewModel.isSavingFixpoint)
                        .accessibilityLabel("\(fix.label) entfernen")
                    }
                }
                ForEach(breaks) { pause in
                    TripBreakRow(pause: pause) {
                        viewModel.select(dayIndex: day.dayIndex)
                        Task { await viewModel.removeBreak(pause) }
                    }
                }
            }
            .font(.subheadline)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.4), in: .rect(cornerRadius: 10))
        }
        if let advice = viewModel.orderAdvice,
           advice.applies(legIndex: viewModel.legIndex, dayIndex: day.dayIndex),
           advice.overrunMinutes > 0 {
            Text(advice.toDrop.isEmpty
                 ? "Der Tag hält nicht alles, und keine Idee ist „Wenn Zeit“ oder „Will“. Ihr entscheidet, was wegfällt."
                 : "Damit der Tag passt, könnten \(advice.toDrop.count) Ideen zurück zu den Ideen. Entfernt wird nichts.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    /// A day trip, as a tile like an excursion's (Mock 16 A): where to,
    /// the way there and back, its "⋯", and — while planning — the
    /// day's spots inside it with "+ Spot in …", since the whole day
    /// happens there.
    private func dayTripRow(_ anchor: TripDayAnchor, day: TripDay, leg: TripLeg,
                            stops: [TripStop]) -> some View {
        let place = anchor.label ?? "Ausflugsziel"
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Label(anchor.label.map { "Ausflug nach \($0)" } ?? "Ausflug", systemImage: leg.transportMode.systemImage)
                    .font(.subheadline.weight(.semibold))
                    .onDrag {
                        NSItemProvider(object: TripStayPlan.excursionDragId(
                            dayIndex: day.dayIndex, excursionId: nil) as NSString)
                    }
                Spacer()
                Menu {
                    Button {
                        dayAction(.dayTrip, day.dayIndex)
                    } label: {
                        Label("Fahrt ändern", systemImage: "clock")
                    }
                    moveMenu(nil, day: day, leg: leg)
                    Button {
                        wayRequest = TripWayRequest(
                            from: .init(name: leg.anchorLabel ?? "Unterkunft", coordinate: leg.anchor),
                            to: .init(name: place, coordinate: TripCoordinate(lat: anchor.lat, lon: anchor.lon)),
                            check: nil, segment: nil, currentMode: leg.transportMode)
                    } label: {
                        Label("Weg zeigen", systemImage: "map")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .frame(minWidth: 44, minHeight: 32)
                        .contentShape(.rect)
                }
                .accessibilityLabel("Aktionen für den Ausflug nach \(place)")
            }
            Text(TripStayPlan.dayTripLine(anchor))
                .font(.caption)
                .foregroundStyle(.secondary)
            ForEach(Array(stops.enumerated()), id: \.element.id) { index, stop in
                planCard(stop, index: index, day: day, leg: leg)
            }
            if !stops.isEmpty {
                insertionLine(TripDropSlot(dayIndex: day.dayIndex, before: nil))
            }
            Button {
                picking = TripPickerRequest(dayTrip: day.dayIndex)
            } label: {
                Label("Spot in \(place)", systemImage: "plus")
                    .font(.subheadline.weight(.semibold))
            }
            .buttonStyle(.borderless)
            .accessibilityHint("Sucht um \(place) und legt auf diesen Tag")
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.08), in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.accentColor.opacity(0.5)))
    }

    /// "Ideen (6) und Suche": the one way into the spot picker.
    // MARK: - Open spots (stage 8)

    /// Above the days before the trip (mock 13 A): what fits, and the
    /// spots no day holds yet, Muss first.
    private func openSection(_ leg: TripLeg) -> some View {
        let open = TripOpenSpots.open(of: leg)
        let shown = showAllOpen ? open : Array(open.prefix(4))
        let fillable = days(of: leg).filter { $0.anchor == nil }
        return VStack(alignment: .leading, spacing: 8) {
            if let capacity = leg.capacity, !open.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text(TripOpenSpots.capacityLine(capacity))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(capacity.fits ? Color.primary : Color.red)
                    if let detail = TripOpenSpots.capacityDetail(capacity) {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            // Nothing open, no heading: the button below is the way in.
            if !open.isEmpty {
                HStack(alignment: .firstTextBaseline) {
                    Text("Noch offen · \(open.count) \(open.count == 1 ? "Spot" : "Spots")")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                        .accessibilityAddTraits(.isHeader)
                    Spacer()
                    if !fillable.isEmpty {
                        Button("Alle Tage füllen") {
                            fillRequest = TripFillRequest(dayIndex: nil, fromMinutes: nil)
                        }
                        .font(.footnote)
                    }
                }
            }
            ForEach(shown) { candidate in
                openCard(candidate, days: fillable, leg: leg)
            }
            if open.count > shown.count {
                Button("\(open.count - shown.count) weitere anzeigen") {
                    withAnimation { showAllOpen = true }
                }
                .font(.footnote)
                .frame(maxWidth: .infinity)
            }
            ideasButton(leg)
        }
    }

    /// One open spot: what it is, how long, its priority and hints.
    /// Dragged onto a day, or put there from its menu, it stands there by hand.
    private func openCard(_ candidate: TripCandidate, days: [TripDay], leg: TripLeg) -> some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(TripSpotName.line(candidate.displayName, local: candidate.localName))
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                Text(TripOpenSpots.cardLine(candidate))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TripIdeaChips(priority: candidate.ideaPriority, ticket: candidate.ticket,
                              closedOn: candidate.closedOn ?? [],
                              openingHours: candidate.openingHours)
            }
            Spacer(minLength: 0)
            if let image = candidate.image {
                TripSpotThumbnail(image: image, height: 48, width: 48, placeholder: false)
            }
            Menu {
                ForEach(days) { day in
                    Button("Auf \(TripStayPlan.dayTitle(day, leg: leg))") {
                        guard let block = TripSpotPicker.spotsBlock(of: day) else { return }
                        Task { _ = await viewModel.place(candidate, inBlock: block.id, onDay: day.dayIndex) }
                    }
                }
                Divider()
                Button("Ideen und Suche", systemImage: "magnifyingglass") { picking = TripPickerRequest() }
            } label: {
                Image(systemName: "ellipsis")
                    .frame(width: 32, height: 32)
                    .contentShape(.rect)
            }
            .accessibilityLabel("Aktionen für \(candidate.displayName)")
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 14))
        .onDrag {
            NSItemProvider(object: TripOpenSpots.dragId(candidate.osmRef) as NSString)
        } preview: {
            Text(candidate.displayName)
                .font(.subheadline.weight(.semibold))
                .padding(8)
                .background(.regularMaterial, in: .rect(cornerRadius: 8))
        }
    }

    /// "Tag füllen" under a coming day, and the hint on the last one
    /// while Muss spots do not fit.
    @ViewBuilder
    private func fillButton(_ day: TripDay, running: Bool, nowMinutes: Int) -> some View {
        if let leg = viewModel.leg, day.dayIndex == days(of: leg).last?.dayIndex,
           let hint = TripOpenSpots.mustHint(open: TripOpenSpots.open(of: leg), capacity: leg.capacity) {
            Label(hint, systemImage: "exclamationmark.triangle")
                .font(.caption)
                .foregroundStyle(.orange)
        }
        Button {
            fillRequest = TripFillRequest(dayIndex: day.dayIndex, fromMinutes: running ? nowMinutes : nil)
        } label: {
            Label("Tag füllen", systemImage: "wand.and.stars")
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 36)
        }
        .buttonStyle(.bordered)
    }

    private func acceptFill(_ days: [(dayIndex: Int, osmRefs: [String])], fromMinutes: Int?) async -> String? {
        do {
            let response = try await TripFillAPI.accept(planId: viewModel.planId, legIndex: viewModel.legIndex,
                                                        days: days, fromMinutes: fromMinutes)
            await viewModel.load()
            withAnimation { undo = WeatherUndo(sentence: response.sentence, opId: response.opId) }
            return nil
        } catch {
            return TripErrorText.describe(error)
        }
    }

    private func ideasButton(_ leg: TripLeg) -> some View {
        Button {
            picking = TripPickerRequest()
        } label: {
            Label(leg.pool.isEmpty ? "Ideen und Suche" : "Ideen (\(leg.pool.count)) und Suche",
                  systemImage: "plus.circle")
                .font(.headline)
                .frame(maxWidth: .infinity, minHeight: 36)
        }
        .buttonStyle(.bordered)
        .tint(.accentColor)
    }

    /// A day that is over, as one line: visited, missed, photos.
    private func pastLine(_ day: TripDay, leg: TripLeg, today: String) -> some View {
        let missed = unanswered(TripOnTheRoad.missed(day, phase: .past, nowMinutes: 0))
        return VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation { _ = expandedPast.insert(day.dayIndex) }
            } label: {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(TripStayPlan.dayTitle(day, leg: leg))
                            .font(.subheadline.weight(.semibold))
                        Text(TripOnTheRoad.pastLine(day, diary: viewModel.diary(dayIndex: day.dayIndex)))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Zeigt den Tag")
            if !missed.isEmpty {
                missedCard(missed, day: day, leg: leg, today: today)
            }
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 14))
    }

    private func daySection(_ day: TripDay, leg: TripLeg, phase: TripDayPhase, now: Date,
                            nowMinutes: Int, today: String) -> some View {
        let stops = TripStayPlan.stops(of: day)
        let onTheRoad = phase == .running || phase == .past
        let order = TripOnTheRoad.runningOrder(stops)
        let next = phase == .running ? order.open.first : nil
        let diary = viewModel.diary(dayIndex: day.dayIndex)
        let behind = phase == .running ? TripOnTheRoad.behindMinutes(day, nowMinutes: nowMinutes) : nil
        let advice = viewModel.reorderAdvice.flatMap {
            $0.legIndex == viewModel.legIndex && $0.dayIndex == day.dayIndex ? $0 : nil
        }
        let missed = unanswered(TripOnTheRoad.missed(day, phase: phase, nowMinutes: nowMinutes))
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(TripStayPlan.dayHeading(day, leg: leg) + (phase == .running ? " · heute" : ""))
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
                if let weather = viewModel.stayForecast(dayIndex: day.dayIndex)?.overall {
                    Label(weather.summary, systemImage: weather.symbolName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .labelStyle(.titleAndIcon)
                }
                Spacer(minLength: 6)
                if let line = onTheRoad ? TripStayPlan.visitedLine(day) : TripStayPlan.fillLine(day) {
                    Text(line)
                        .font(.caption)
                        .foregroundStyle(!onTheRoad && (day.overrunMinutes ?? 0) > 0 ? Color.red : Color.secondary)
                }
                if phase != .past {
                    dayMenu(day, leg: leg, hasStops: !stops.isEmpty)
                }
            }

            if phase != .past {
                dayFrame(day, leg: leg)
            }

            if phase != .past, let note = weatherNotes.first(where: { $0.dayIndex == day.dayIndex }) {
                TripWeatherNoteCard(note: note, leg: leg, busy: applyingNote == note.dayIndex,
                                    swap: { swapping = note },
                                    moveOutdoor: { Task { await applyNote(note, kind: "outdoor") } })
            }

            if let anchor = day.anchor, phase != .past {
                dayTripRow(anchor, day: day, leg: leg, stops: onTheRoad ? [] : stops)
            }

            if stops.isEmpty && (day.excursions ?? []).isEmpty && day.anchor == nil {
                Button {
                    picking = TripPickerRequest(dayTrip: day.anchor == nil ? nil : day.dayIndex,
                                                day: day.anchor == nil ? day.dayIndex : nil)
                } label: {
                    Text("Spot hierher ziehen oder aus den Ideen hinzufügen")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity, minHeight: 72)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                    .background {
                        RoundedRectangle(cornerRadius: 12)
                            .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [6, 4]))
                            .foregroundStyle(dropSlot?.dayIndex == day.dayIndex ? Color.accentColor : Color.secondary.opacity(0.5))
                    }
            } else if onTheRoad {
                if let behind, advice == nil {
                    behindNotice(behind, day: day, nowMinutes: nowMinutes)
                }
                if let advice {
                    adviceCard(advice, leg: leg)
                }
                ForEach(order.settled) { stop in
                    card(stop, day: day, number: nil, mode: .settled(fresh: TripOnTheRoad.isFresh(stop, now: now)),
                         diary: diary?.spot(stop.osmRef))
                }
                ForEach(diary?.unplanned ?? []) { stay in
                    stayRow(stay, dayIndex: day.dayIndex)
                }
                if phase == .running {
                    nowLine(nowMinutes)
                }
                ForEach(Array(order.open.enumerated()), id: \.element.id) { index, stop in
                    let slot = TripDropSlot(dayIndex: day.dayIndex, before: stops.firstIndex { $0.rowId == stop.rowId })
                    insertionLine(slot)
                    wayLine(to: stop, on: day, leg: leg)
                    card(stop, day: day, number: index + 1,
                         mode: .open(isNext: stop.rowId == next?.rowId, canCheck: phase == .running),
                         diary: nil)
                        .modifier(swipeToDelete(stop))
                        .modifier(reorderable(stop, slot: slot, day: day))
                }
                insertionLine(TripDropSlot(dayIndex: day.dayIndex, before: nil))
                if phase == .running {
                    addSpotButton(day, leg: leg)
                }
                if !missed.isEmpty {
                    missedCard(missed, day: day, leg: leg, today: today)
                }
                if phase == .past {
                    Button("Einklappen") {
                        withAnimation { _ = expandedPast.remove(day.dayIndex) }
                    }
                    .font(.footnote)
                    .frame(maxWidth: .infinity)
                }
            } else if day.anchor != nil {
                // The spots stand in the day trip's tile.
                EmptyView()
            } else if (day.excursions ?? []).isEmpty {
                ForEach(Array(stops.enumerated()), id: \.element.id) { index, stop in
                    planCard(stop, index: index, day: day, leg: leg)
                }
                insertionLine(TripDropSlot(dayIndex: day.dayIndex, before: nil))
                addSpotButton(day, leg: leg)
            } else {
                // A day with excursions (Mock 16): each window is a
                // section of its own, the rest of the day at the quarters.
                // Excursions that go on from each other (Mock 18) are one
                // frame with a destination per window.
                let groups = TripExcursionChain.groups(TripStayPlan.sections(of: day))
                ForEach(Array(groups.enumerated()), id: \.element.id) { at, group in
                    switch group {
                    case .home(let section):
                        ForEach(Array(section.block.stops.enumerated()), id: \.element.id) { offset, stop in
                            planCard(stop, index: section.offset + offset, day: day, leg: leg)
                        }
                    case .chain(let links):
                        excursionSection(links, next: TripExcursionChain.next(after: at, in: groups),
                                         day: day, leg: leg)
                    }
                }
                insertionLine(TripDropSlot(dayIndex: day.dayIndex, before: nil))
                addSpotButton(day, leg: leg)
            }
            if phase != .past, day.anchor == nil, !TripOpenSpots.open(of: leg).isEmpty {
                fillButton(day, running: phase == .running, nowMinutes: nowMinutes)
            }
        }
        // The day is a heading over its cards, not a box around them.
        .padding(.vertical, 4)
        .onDrop(of: [.plainText], delegate: TripStopDropDelegate(
            slot: TripDropSlot(dayIndex: day.dayIndex, before: nil), current: $dropSlot,
        ) { ids in
            drop(ids, onDay: day, before: nil)
        })
    }

    /// One card of the plan with its drop line and way line.
    @ViewBuilder
    private func planCard(_ stop: TripStop, index: Int, day: TripDay, leg: TripLeg) -> some View {
        let slot = TripDropSlot(dayIndex: day.dayIndex, before: index)
        insertionLine(slot)
        wayLine(to: stop, on: day, leg: leg)
        card(stop, day: day, number: index + 1, mode: .plan, diary: nil)
            .modifier(swipeToDelete(stop))
            .modifier(reorderable(stop, slot: slot, day: day))
    }

    /// "+ Spot" under a day that already has some: the picker opens for
    /// this day — around the destination of a day out, else at the
    /// quarters — and "+" puts the spot here.
    private func addSpotButton(_ day: TripDay, leg: TripLeg) -> some View {
        Button {
            picking = TripPickerRequest(dayTrip: day.anchor == nil ? nil : day.dayIndex,
                                        day: day.anchor == nil ? day.dayIndex : nil)
        } label: {
            Label(day.anchor == nil && !(day.excursions ?? []).isEmpty ? "Spot in \(leg.displayTitle)" : "Spot hinzufügen",
                  systemImage: "plus")
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 40)
        }
        .buttonStyle(.bordered)
    }

    /// "Auf anderen Tag" for an outing: the days it may go to.
    private func moveMenu(_ excursion: TripExcursion?, day: TripDay, leg: TripLeg) -> some View {
        Menu {
            moveMenuItems(excursion, day: day, leg: leg)
        } label: {
            Label("Auf anderen Tag", systemImage: "calendar")
        }
        .disabled(TripStayPlan.excursionMoveTargets(leg, from: day.dayIndex, wholeDay: excursion == nil).isEmpty)
    }

    @ViewBuilder
    private func moveMenuItems(_ excursion: TripExcursion?, day: TripDay, leg: TripLeg) -> some View {
        ForEach(TripStayPlan.excursionMoveTargets(leg, from: day.dayIndex, wholeDay: excursion == nil)) { target in
            Button(target.label) {
                Task { await viewModel.moveExcursion(excursion, from: day.dayIndex, to: target.dayIndex) }
            }
        }
    }

    /// An excursion as a section of the day (Mock 16 A): where to, the
    /// hours, its own spots, "+ Spot in …", and below it the way back.
    /// A chain (Mock 18 A) is one frame with each destination under the
    /// one before, the hop between them, and "+ Weiteres Ziel anhängen";
    /// `next` is an excursion right after it that could go on from it
    /// instead of from the quarters (Mock 18 B, "Direkt weiter").
    private func excursionSection(_ links: [TripStaySection], next: TripExcursion?,
                                  day: TripDay, leg: TripLeg) -> some View {
        let chain = links.compactMap(\.excursion)
        let first = chain.first
        let last = chain.last
        return VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    Label(TripExcursionChain.title(chain), systemImage: leg.transportMode.systemImage)
                        .font(.subheadline.weight(.semibold))
                        .onDrag {
                            NSItemProvider(object: TripStayPlan.excursionDragId(
                                dayIndex: day.dayIndex, excursionId: first?.id ?? "") as NSString)
                        }
                    Spacer()
                    if chain.count == 1, let first {
                        excursionMenu(first, day: day, leg: leg)
                    } else if let first {
                        Menu {
                            moveMenu(first, day: day, leg: leg)
                        } label: {
                            Image(systemName: "ellipsis.circle")
                                .frame(minWidth: 44, minHeight: 32)
                                .contentShape(.rect)
                        }
                        .accessibilityLabel("Aktionen für \(TripExcursionChain.title(chain))")
                    }
                }
                Text(TripExcursionChain.line(chain))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                ForEach(Array(links.enumerated()), id: \.element.id) { at, section in
                    if let excursion = section.excursion {
                        if chain.count > 1 {
                            if at > 0 {
                                Label(TripExcursionChain.hopLine(excursion), systemImage: leg.transportMode.systemImage)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 6)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(Color.accentColor.opacity(0.10), in: .rect(cornerRadius: 8))
                            }
                            HStack(alignment: .firstTextBaseline) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Label(excursion.displayName, systemImage: "mappin.circle.fill")
                                        .font(.subheadline.weight(.semibold))
                                    Text(TripExcursionChain.stopLine(excursion, goesOn: at < links.count - 1))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                excursionMenu(excursion, day: day, leg: leg)
                            }
                        }
                        ForEach(Array(section.block.stops.enumerated()), id: \.element.id) { offset, stop in
                            planCard(stop, index: section.offset + offset, day: day, leg: leg)
                        }
                        Button {
                            picking = TripPickerRequest(excursion: TripExcursionPick(dayIndex: day.dayIndex,
                                                                                     excursion: excursion))
                        } label: {
                            Label("Spot in \(excursion.displayName)", systemImage: "plus")
                                .font(.subheadline.weight(.semibold))
                        }
                        .buttonStyle(.borderless)
                        .accessibilityHint("Sucht um \(excursion.displayName) und legt in dieses Zeitfenster")
                    }
                }
                if let last {
                    Button {
                        dayAction(.appendExcursion(last), day.dayIndex)
                    } label: {
                        Label("Weiteres Ziel anhängen", systemImage: "plus")
                            .font(.footnote)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityHint("Fährt von \(last.displayName) direkt weiter, ohne Rückfahrt dazwischen")
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.accentColor.opacity(0.08), in: .rect(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.accentColor.opacity(0.5)))
            if let last {
                HStack(alignment: .firstTextBaseline) {
                    Text("↓ zurück in \(leg.displayTitle) ca. \(TripClock.format(last.backHomeMinutes))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    if let next, TripExcursionChain.canLink(last, next),
                       TripExcursionLink(dayIndex: day.dayIndex, last: last, next: next).suggestion == nil {
                        Button {
                            linking = TripExcursionLink(dayIndex: day.dayIndex, last: last, next: next)
                        } label: {
                            Text("Direkt weiter ›")
                                .font(.caption.weight(.semibold))
                        }
                        .buttonStyle(.borderless)
                        .accessibilityHint("Von \(last.displayName) direkt nach \(next.displayName), ohne Rückfahrt")
                    }
                }
                // The app suggests it when going on is nearer than going
                // home (Anton, 13.11.).
                if let next, TripExcursionChain.canLink(last, next),
                   let suggestion = TripExcursionLink(dayIndex: day.dayIndex, last: last, next: next).suggestion {
                    Button {
                        linking = TripExcursionLink(dayIndex: day.dayIndex, last: last, next: next)
                    } label: {
                        HStack(alignment: .firstTextBaseline) {
                            Label("Direkt weiter nach \(next.displayName)?", systemImage: "arrow.turn.down.right")
                                .font(.footnote.weight(.semibold))
                            Spacer()
                            Text("spart ca. \(TripClock.duration(suggestion.savedMinutes))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(Color.accentColor.opacity(0.12), in: .rect(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("\(TripClock.duration(suggestion.hopMinutes)) statt \(TripClock.duration(suggestion.viaQuartersMinutes)) über \(leg.displayTitle)")
                }
            }
        }
    }

    /// The "⋯" of one destination: its hours, the day it is on, the way
    /// there, going back to the quarters before it, and taking it off.
    private func excursionMenu(_ excursion: TripExcursion, day: TripDay, leg: TripLeg) -> some View {
        let pick = TripExcursionPick(dayIndex: day.dayIndex, excursion: excursion)
        let before = TripExcursionChain.before(excursion, in: day)
        return Menu {
            Button {
                dayAction(.excursion(excursion), day.dayIndex)
            } label: {
                Label("Zeiten ändern", systemImage: "clock")
            }
            if before == nil {
                moveMenu(excursion, day: day, leg: leg)
            }
            Button {
                wayRequest = TripWayRequest(
                    from: before.map { TripWayRequest.End(name: $0.displayName, coordinate: $0.coordinate) }
                        ?? TripWayRequest.End(name: leg.anchorLabel ?? "Unterkunft", coordinate: leg.anchor),
                    to: .init(name: excursion.displayName, coordinate: excursion.coordinate),
                    check: nil, segment: nil, currentMode: leg.transportMode)
            } label: {
                Label("Weg zeigen", systemImage: "map")
            }
            if before != nil {
                Button {
                    Task {
                        if let failure = await viewModel.linkExcursion(excursion, after: nil, dayIndex: day.dayIndex) {
                            viewModel.errorMessage = failure
                        }
                    }
                } label: {
                    Label("Dazwischen zurück zur Unterkunft", systemImage: "house")
                }
            }
            Button(role: .destructive) {
                removingExcursion = pick
            } label: {
                Label(before == nil && TripExcursionChain.after(excursion, in: day) == nil
                      ? "Ausflug entfernen" : "Ziel entfernen", systemImage: "trash")
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .frame(minWidth: 44, minHeight: 32)
                .contentShape(.rect)
        }
        .accessibilityLabel("Aktionen für \(excursion.title)")
    }

    /// Dragging a card to another place (the system's lift, a line where
    /// it would land, and a move, not the green "+" of a copy).
    private func reorderable(_ stop: TripStop, slot: TripDropSlot, day: TripDay) -> TripReorderable {
        TripReorderable(id: TripStayPlan.dragId(stop), name: stop.displayName, slot: slot, current: $dropSlot) { ids in
            drop(ids, onDay: day, before: slot.before)
        }
    }

    /// Swiping a card to the left deletes it, as in every list on iOS
    /// (Anton, 10.11.): the same "Löschen" as at the bottom of its menu.
    private func swipeToDelete(_ stop: TripStop) -> TripSwipeToDelete {
        let delete = stopActions(stop).first { $0.id == "delete" && !$0.disabled }
        return TripSwipeToDelete(enabled: delete != nil, onSwipe: { swipedAt = Date() }) {
            if let delete { Task { await delete.run() } }
        }
    }

    /// The line where a dragged card would go, as lists draw it.
    @ViewBuilder
    private func insertionLine(_ slot: TripDropSlot) -> some View {
        if dropSlot == slot {
            Capsule()
                .fill(Color.accentColor)
                .frame(height: 3)
                .padding(.vertical, 2)
                .transition(.opacity)
                .accessibilityHidden(true)
        }
    }

    /// How a card is drawn: planning ahead, still to come on the road
    /// (with the check, and "Route" on the next one), or settled.
    private enum CardMode: Equatable {
        case plan
        case open(isNext: Bool, canCheck: Bool)
        case settled(fresh: Bool)
    }

    private func card(_ stop: TripStop, day: TripDay, number: Int?, mode: CardMode,
                      diary: TripDiarySpot?) -> some View {
        let visit = viewModel.visit(holding: stop, onDay: day.dayIndex)
        let isNext: Bool = {
            if case .open(let next, _) = mode { return next }
            return false
        }()
        let isSettled: Bool = {
            if case .settled = mode { return true }
            return false
        }()
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 10) {
                if mode == .plan {
                    // A pin only where a fixed time holds the spot: on
                    // every other card it said nothing (Anton, 10.11.).
                    if visit != nil {
                        Image(systemName: "pin.fill")
                            .font(.body)
                            .foregroundStyle(Color.accentColor)
                            .frame(width: 22)
                            .accessibilityLabel("Feste Zeit")
                    }
                } else {
                    checkControl(stop, mode: mode)
                }
                Button {
                    guard !TripSwipeToDelete.justSwiped(swipedAt) else { return }
                    detailPick = TripStayDetailPick(stop: stop, dayIndex: day.dayIndex)
                } label: {
                    HStack(alignment: .center, spacing: 10) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(TripSpotName.line(stop.displayName, local: stop.localName))
                                .font(.subheadline.weight(.semibold))
                                .strikethrough(stop.stopStatus == .skipped)
                                .lineLimit(2)
                            if case .settled = mode {
                                settledLine(stop, diary: diary)
                            } else {
                                Text(TripStayPlan.kindLine(stop))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                if stop.isSoft, stop.stopStatus == .planned {
                                    // What the day does not reach is open again in the evening.
                                    Label("von der App", systemImage: "sparkles")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                                if let summary = stop.summary {
                                    Text(summary)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                }
                                let line = TripStayPlan.timeLine(
                                    stop, pin: visit.map { (reason: $0.reason, startMinutes: $0.startMinutes) })
                                if !line.isEmpty {
                                    Text(line)
                                        .font(.caption)
                                        .foregroundStyle(stop.outsideHours == true ? Color.red : Color.primary)
                                }
                                if let extent = stop.extent {
                                    Label(extent.summary, systemImage: "point.topleft.down.to.point.bottomright.curvepath")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                // Only what is wrong: closed that day, hours nobody can read.
                                TripIdeaChips(priority: .want,
                                              closedThatDay: stop.closedThatDay == true,
                                              openingHours: stop.openingHours)
                            }
                        }
                        Spacer(minLength: 0)
                        // A picture only where there is one: no grey box
                        // in its place (Anton, 10.11.).
                        if let image = stop.image {
                            TripSpotThumbnail(image: image, height: 56, width: 56, placeholder: false)
                        }
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)

                Menu {
                    TripSpotActionMenuItems(actions: stopActions(stop))
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: 32, height: 32)
                        .contentShape(.rect)
                }
                .accessibilityLabel("Aktionen für \(stop.displayName)")
            }
            if let photos = diary?.photos, !photos.isEmpty {
                HStack(spacing: 4) {
                    ForEach(photos) { photo in
                        PhotoThumbnailView(filename: photo.filename, photoId: photo.id)
                            .frame(width: 44, height: 44)
                            .clipShape(.rect(cornerRadius: 6))
                    }
                }
                .accessibilityHidden(true)
            }
            if mode == .settled(fresh: true) {
                HStack {
                    Text("Gerade abgehakt")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Doch nicht") {
                        Task { await viewModel.mark(stop, as: .planned) }
                    }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
            if isNext {
                Button {
                    if let leg = viewModel.leg { wayRequest = makeWayRequest(to: stop, on: day, leg: leg, fromHere: true) }
                } label: {
                    Label("Route", systemImage: "arrow.triangle.turn.up.right.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            } else if stop.extent != nil && !isSettled {
                // A route is a long card: it starts somewhere, and
                // getting there is a way of its own.
                Button {
                    if let leg = viewModel.leg { wayRequest = makeWayRequest(to: stop, on: day, leg: leg, fromHere: true) }
                } label: {
                    Label("Weg zum Start", systemImage: "arrow.triangle.turn.up.right.circle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
        .padding(12)
        // A card of its own, with a frame (mock "Den Aufenthalt planen").
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(isNext ? Color.accentColor : Color(.separator), lineWidth: isNext ? 2 : 1)
        }
        .opacity(stop.stopStatus == .skipped ? 0.6 : 1)
    }

    /// The check on a card on the road: an empty circle that ticks the
    /// spot off by hand, a filled one that offers "Nicht besucht".
    @ViewBuilder
    private func checkControl(_ stop: TripStop, mode: CardMode) -> some View {
        switch mode {
        case .plan:
            EmptyView()
        case .open(_, let canCheck):
            if canCheck {
                Button {
                    Task { await viewModel.mark(stop, as: .done) }
                } label: {
                    Image(systemName: "circle")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                        .frame(width: 32, height: 56)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(stop.displayName) abhaken")
            }
        case .settled:
            Button {
                unchecking = stop
            } label: {
                Image(systemName: stop.stopStatus == .done ? "checkmark.circle.fill" : "xmark.circle")
                    .font(.title2)
                    .foregroundStyle(stop.stopStatus == .done ? Color.green : Color.secondary)
                    .frame(width: 32, height: 56)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(stop.stopStatus == .done ? "Besucht, antippen für „Nicht besucht“"
                                                         : "Übersprungen, antippen für „Doch wieder offen“")
        }
    }

    /// "10:42 · 18° · 4 Fotos" on a visited card.
    private func settledLine(_ stop: TripStop, diary: TripDiarySpot?) -> some View {
        HStack(spacing: 6) {
            if stop.stopStatus == .skipped {
                Text("Übersprungen")
            } else if let time = stop.doneTime {
                Text(time)
            }
            if let weather = diary?.weather {
                Label(weather.degrees, systemImage: weather.symbolName)
                    .labelStyle(.titleAndIcon)
            }
            if let count = diary?.photoCount, count > 0 {
                Label(count == 1 ? "1 Foto" : "\(count) Fotos", systemImage: "photo")
                    .labelStyle(.titleAndIcon)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    /// A place the group stayed at without a plan.
    private func stayRow(_ stay: TripDiaryStay, dayIndex: Int) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "mappin.and.ellipse")
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(width: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(stay.displayName)
                    .font(.subheadline.weight(.semibold))
                HStack(spacing: 6) {
                    Text("Ungeplant")
                    if let time = stay.arrivalTime { Text(time) }
                    if let weather = stay.weather {
                        Label(weather.degrees, systemImage: weather.symbolName).labelStyle(.titleAndIcon)
                    }
                    if stay.photoCount > 0 {
                        Label(stay.photoCount == 1 ? "1 Foto" : "\(stay.photoCount) Fotos", systemImage: "photo")
                            .labelStyle(.titleAndIcon)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Menu {
                Button("Aus dem Tag entfernen", systemImage: "trash", role: .destructive) {
                    Task { await viewModel.removeStay(stay, dayIndex: dayIndex) }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .frame(width: 32, height: 32)
                    .contentShape(.rect)
            }
            .accessibilityLabel("Aktionen für \(stay.displayName)")
        }
        .padding(10)
        .background(Color(.systemBackground), in: .rect(cornerRadius: 10))
    }

    /// The line between what was and what is to come.
    private func nowLine(_ nowMinutes: Int) -> some View {
        HStack(spacing: 8) {
            Text("jetzt · \(TripClock.format(nowMinutes))")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.accentColor)
            Rectangle()
                .fill(Color.accentColor)
                .frame(height: 1.5)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    /// Behind plan: what is left does not fit any more.
    private func behindNotice(_ minutes: Int, day: TripDay, nowMinutes: Int) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "clock.badge.exclamationmark")
                .foregroundStyle(.orange)
            Text("Ab jetzt passt nicht mehr alles – \(TripClock.duration(minutes)) zu viel.")
                .font(.subheadline)
            Spacer(minLength: 0)
            Button("Neu ordnen") {
                Task { await viewModel.reorderFromNow(dayIndex: day.dayIndex, nowMinutes: nowMinutes) }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(10)
        .background(Color.orange.opacity(0.12), in: .rect(cornerRadius: 10))
    }

    /// After "Neu ordnen": what still does not fit, each with its other day.
    private func adviceCard(_ advice: TripReorderAdvice, leg: TripLeg) -> some View {
        let stops = leg.days.flatMap(TripStayPlan.stops(of:))
        return VStack(alignment: .leading, spacing: 8) {
            Text("Neu geordnet. Das passt heute nicht mehr:")
                .font(.subheadline.weight(.semibold))
            ForEach(advice.moves) { move in
                if let stop = stops.first(where: { $0.osmRef == move.osmRef }) {
                    HStack {
                        Text(stop.displayName)
                            .font(.subheadline)
                            .lineLimit(1)
                        Spacer()
                        if let target = move.dayIndex, let blockId = move.blockId {
                            Button("Auf Tag \(target + 1)") {
                                Task {
                                    _ = await viewModel.move(stop, toDayIndex: target, toBlockId: blockId)
                                    viewModel.reorderAdvice = nil
                                }
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }
                        Button("Zu den Ideen") {
                            Task {
                                await viewModel.returnToPool(stop)
                                viewModel.reorderAdvice = nil
                            }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                }
            }
            Button("Lassen, wie es ist") { viewModel.reorderAdvice = nil }
                .font(.footnote)
        }
        .padding(10)
        .background(Color.orange.opacity(0.12), in: .rect(cornerRadius: 10))
    }

    /// The evening question, once per spot: another day, or back to the ideas.
    private func missedCard(_ stops: [TripStop], day: TripDay, leg: TripLeg, today: String) -> some View {
        let later = TripOnTheRoad.laterDay(after: day.dayIndex, in: leg, today: today)
        let target = later.flatMap { TripStayPlan.dropTarget(day: $0, before: nil) }
        return VStack(alignment: .leading, spacing: 8) {
            Text(stops.count == 1 ? "Nicht geschafft" : "\(stops.count) Spots nicht geschafft")
                .font(.subheadline.weight(.semibold))
            ForEach(stops) { stop in
                HStack {
                    Text(stop.displayName)
                        .font(.subheadline)
                        .lineLimit(1)
                    Spacer()
                    if let later, let target {
                        Button("Auf Tag \(later.dayIndex + 1)") {
                            Task {
                                _ = await viewModel.move(stop, toDayIndex: later.dayIndex, toBlockId: target.blockId)
                            }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                    Button("Zu den Ideen") {
                        Task { await viewModel.returnToPool(stop) }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
            Button("Lassen") { answer(stops) }
                .font(.footnote)
        }
        .padding(10)
        .background(Color(.tertiarySystemGroupedBackground), in: .rect(cornerRadius: 10))
    }

    private func unanswered(_ stops: [TripStop]) -> [TripStop] {
        let answered = Set(missedAnswered.split(separator: ",").compactMap { Int($0) })
        return stops.filter { !answered.contains($0.rowId) }
    }

    private func answer(_ stops: [TripStop]) {
        var answered = missedAnswered.split(separator: ",").map(String.init)
        answered.append(contentsOf: stops.map { String($0.rowId) })
        // The newest two hundred are enough to remember a trip by.
        missedAnswered = answered.suffix(200).joined(separator: ",")
    }

    /// Moves the dragged stop onto `day`, before the card at `before`
    /// (counted among the day's stops) or to the end.
    private func drop(_ items: [String], onDay day: TripDay, before: Int?) -> Bool {
        dropSlot = nil
        if let dragged = items.first.flatMap(TripStayPlan.excursion(fromDragId:)) {
            guard dragged.dayIndex != day.dayIndex, let leg = viewModel.leg else { return false }
            let excursion = dragged.excursionId.flatMap { id in
                leg.days.first { $0.dayIndex == dragged.dayIndex }?.excursions?.first { $0.id == id }
            }
            guard dragged.excursionId == nil || excursion != nil else { return false }
            let allowed = TripStayPlan.excursionMoveTargets(leg, from: dragged.dayIndex, wholeDay: excursion == nil)
            guard allowed.contains(where: { $0.dayIndex == day.dayIndex }) else { return false }
            Task { await viewModel.moveExcursion(excursion, from: dragged.dayIndex, to: day.dayIndex) }
            return true
        }
        if let osmRef = items.first.flatMap(TripOpenSpots.osmRef(fromDragId:)) {
            // An open spot dragged onto a day stands there by hand.
            guard let target = TripStayPlan.dropTarget(day: day, before: before) else { return false }
            Task { _ = await viewModel.place(osmRef: osmRef, inBlock: target.blockId, onDay: day.dayIndex) }
            return true
        }
        guard let leg = viewModel.leg,
              let rowId = items.first.flatMap(TripStayPlan.rowId(fromDragId:)),
              let stop = TripStayPlan.stop(rowId: rowId, in: leg),
              let target = TripStayPlan.dropTarget(day: day, before: before)
        else { return false }
        Task {
            await viewModel.move(stop, toDayIndex: day.dayIndex, toBlockId: target.blockId,
                                 position: target.position)
        }
        return true
    }

    // MARK: - Map

    private func map(_ leg: TripLeg) -> some View {
        let today = TripCalendar.isoDay(Date())
        let running = leg.days.first { TripOnTheRoad.phase(of: $0.dayIndex, in: leg, today: today) == .running }
        // The day whose visits draw their line: the one chosen, else the one being lived.
        let pathDay = mapDay.flatMap { index in leg.days.first { $0.dayIndex == index } } ?? running
        let path = pathDay.map { TripOnTheRoad.visitPath($0, diary: viewModel.diary(dayIndex: $0.dayIndex)) } ?? []
        let next = running.flatMap { TripOnTheRoad.next(TripStayPlan.stops(of: $0)) }
        var photoCounts: [Int: Int] = [:]
        for day in leg.days {
            guard let diary = viewModel.diary(dayIndex: day.dayIndex) else { continue }
            for stop in TripStayPlan.stops(of: day) {
                if let count = diary.spot(stop.osmRef)?.photoCount, count > 0 { photoCounts[stop.rowId] = count }
            }
        }
        let markers = TripStayPlan.markers(leg: leg, selectedDay: mapDay, ideas: showIdeasOnMap,
                                           nextRowId: next?.rowId, photoCounts: photoCounts)
        // The streets are drawn for the chosen day only, one segment at a time.
        let wayDay = mapDay.flatMap { index in leg.days.first { $0.dayIndex == index } }
        return VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    chip("Alle Tage", selected: mapDay == nil) { mapDay = nil }
                    ForEach(days(of: leg)) { day in
                        chip("Tag \(day.dayIndex + 1)", selected: mapDay == day.dayIndex) { mapDay = day.dayIndex }
                    }
                    chip("Ideen", selected: showIdeasOnMap) { showIdeasOnMap.toggle() }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }
            .background(.bar)

            Map {
                UserAnnotation()
                if let wayDay {
                    ForEach(viewModel.dayWays(dayIndex: wayDay.dayIndex) ?? []) { way in
                        dayWay(way, day: wayDay, leg: leg)
                    }
                }
                if path.count >= 2 {
                    MapPolyline(coordinates: path.map {
                        CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon)
                    })
                    .stroke(Color.green, style: StrokeStyle(lineWidth: 3, dash: [6, 4]))
                }
                Annotation("Unterkunft", coordinate: CLLocationCoordinate2D(latitude: leg.anchor.lat,
                                                                           longitude: leg.anchor.lon)) {
                    Image(systemName: "bed.double.fill")
                        .font(.caption)
                        .foregroundStyle(.white)
                        .frame(width: 26, height: 26)
                        .background(Color.secondary, in: .circle)
                }
                if let wayDay, let minutes = sliderMinutes,
                   let here = TripStayPlan.position(at: minutes, day: wayDay, leg: leg) {
                    Annotation("Nach Plan um \(TripClock.format(minutes))",
                               coordinate: CLLocationCoordinate2D(latitude: here.lat, longitude: here.lon)) {
                        Image(systemName: "figure.walk.circle.fill")
                            .font(.title)
                            .foregroundStyle(.white, Color.accentColor)
                    }
                }
                ForEach(markers) { marker in
                    Annotation(marker.title, coordinate: marker.coordinate) {
                        Button {
                            tap(marker, leg: leg)
                        } label: {
                            TripStayMarkerLabel(marker: marker)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(marker.accessibilityLabel)
                    }
                }
            }
            .mapStyle(.standard(pointsOfInterest: .excludingAll))
            .task(id: wayDay.map(wayKey)) {
                if let wayDay { await viewModel.loadDayWays(dayIndex: wayDay.dayIndex) }
            }

            // Where the plan has you at an hour, say to check a light
            // (mock "Kartenvarianten", B): only for one chosen day.
            if let wayDay, let window = wayDay.window, window.minutes > 0 {
                timeSlider(window: window)
            }
        }
        .onChange(of: mapDay) { sliderMinutes = nil }
        // A tap on a marker opens the same things the card offers
        // (mock "Kartenvarianten", B): Details, Route, the actions.
        .sheet(item: $picked, onDismiss: {
            let work = afterPin
            afterPin = nil
            work?()
        }) { pick in
            pinSheet(pick.marker, leg: leg)
                .presentationDetents([.height(210)])
                .presentationDragIndicator(.visible)
                .opaqueSheetBackground()
        }
    }

    /// The marker's sheet: what it is, and Details · Route · Aktionen
    /// for a stop, "+ Tag n" for an idea.
    @ViewBuilder
    private func pinSheet(_ marker: TripStayMarker, leg: TripLeg) -> some View {
        let stop: TripStop? = {
            if case .stop(let rowId) = marker.kind { return TripStayPlan.stop(rowId: rowId, in: leg) }
            return nil
        }()
        let idea: TripCandidate? = {
            if case .idea(let osmRef) = marker.kind { return leg.pool.first { $0.osmRef == osmRef } }
            return nil
        }()
        let targets = days(of: leg).filter { $0.dayIndex != marker.dayIndex }
        let preferred = mapDay.flatMap { index in targets.first { $0.dayIndex == index } } ?? targets.first
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(marker.title)
                        .font(.headline)
                        .lineLimit(2)
                    if let stop {
                        Text("Tag \((marker.dayIndex ?? 0) + 1) · \(TripStayPlan.kindLine(stop))")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        let caption = TripStayPlan.caption(stop)
                        if !caption.isEmpty {
                            Text(caption).font(.caption).foregroundStyle(.secondary)
                        }
                    } else if let idea {
                        Text("Idee · \(TripCategory.label(idea.category)) · \(TripClock.duration(idea.dwellMinutes))")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
                if let image = stop?.image ?? idea?.image {
                    TripSpotThumbnail(image: image, height: 56, width: 56)
                }
            }
            HStack(spacing: 8) {
                if let stop, let dayIndex = marker.dayIndex {
                    Button("Details") {
                        afterPin = { detailPick = TripStayDetailPick(stop: stop, dayIndex: dayIndex) }
                        picked = nil
                    }
                    .frame(maxWidth: .infinity)
                    Button("Route") {
                        if let day = leg.days.first(where: { $0.dayIndex == dayIndex }) {
                            let request = makeWayRequest(to: stop, on: day, leg: leg, fromHere: marker.isNext)
                            afterPin = { wayRequest = request }
                        }
                        picked = nil
                    }
                    .frame(maxWidth: .infinity)
                    Menu("Aktionen") {
                        TripSpotActionMenuItems(actions: stopActions(stop))
                    }
                    .frame(maxWidth: .infinity)
                } else if idea != nil, let preferred {
                    Button("+ Tag \(preferred.dayIndex + 1)") {
                        picked = nil
                        Task { await add(marker, to: preferred, leg: leg) }
                    }
                    .buttonStyle(.borderedProminent)
                    .frame(maxWidth: .infinity)
                    if targets.count > 1 {
                        Menu("Anderer Tag") {
                            ForEach(targets.filter { $0.dayIndex != preferred.dayIndex }) { day in
                                Button("Tag \(day.dayIndex + 1)") {
                                    picked = nil
                                    Task { await add(marker, to: day, leg: leg) }
                                }
                            }
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
            }
            .buttonStyle(.bordered)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func timeSlider(window: TripDayWindow) -> some View {
        let value = Binding<Double>(
            get: { Double(sliderMinutes ?? window.startMinutes) },
            set: { sliderMinutes = Int($0) },
        )
        return HStack(spacing: 12) {
            Text(TripClock.format(sliderMinutes ?? window.startMinutes))
                .font(.subheadline.monospacedDigit().weight(.semibold))
                .frame(width: 52, alignment: .leading)
            Slider(value: value, in: Double(window.startMinutes)...Double(window.endMinutes), step: 5)
                .accessibilityLabel("Uhrzeit nach Plan")
                .accessibilityValue(TripClock.format(sliderMinutes ?? window.startMinutes))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    /// A stay of one day has nowhere else to put an idea: the tap puts
    /// it there instead of asking which day.
    private func tap(_ marker: TripStayMarker, leg: TripLeg) {
        let all = days(of: leg)
        if case .idea = marker.kind, all.count == 1, let only = all.first {
            Task { await add(marker, to: only, leg: leg) }
        } else {
            picked = TripStayMapPick(marker: marker)
        }
    }

    /// What the day's ways depend on: its order and the modes picked.
    private func wayKey(_ day: TripDay) -> String {
        let stops = TripStayPlan.stops(of: day)
        return "\(day.dayIndex)|\(stops.map(\.osmRef))|\(stops.map { $0.wayMode ?? "" })"
    }

    /// One segment of the chosen day on the map: along the streets where
    /// it was routed, a dashed straight line where it was not (public
    /// transport has no timetable), and its duration as a label that
    /// opens "Weg".
    @MapContentBuilder
    private func dayWay(_ way: TripDayWay, day: TripDay, leg: TripLeg) -> some MapContent {
        let points = TripWays.path(shape: way.shape, from: way.from, to: way.to)
        MapPolyline(coordinates: points.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon) })
            .stroke(way.shape == nil ? Color.secondary : Color.accentColor.opacity(0.8),
                    style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round,
                                       dash: way.shape == nil ? [6, 5] : []))
        if let middle = TripWays.midpoint(of: points),
           let stop = TripStayPlan.stops(of: day).first(where: { $0.osmRef == way.toRef }) {
            Annotation("", coordinate: CLLocationCoordinate2D(latitude: middle.lat, longitude: middle.lon)) {
                Button {
                    wayRequest = makeWayRequest(to: stop, on: day, leg: leg, fromHere: false)
                } label: {
                    Label(TripClock.duration(way.minutes), systemImage: way.doneBy.systemImage)
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(.regularMaterial, in: .capsule)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Weg nach \(stop.displayName), \(TripClock.duration(way.minutes)) \(way.doneBy.label)")
            }
        }
    }

    /// The line between two cards: how long the way to this spot takes
    /// and by what. A tap opens "Weg" with both ends filled in.
    @ViewBuilder
    private func wayLine(to stop: TripStop, on day: TripDay, leg: TripLeg) -> some View {
        let travel = stop.travelFromPrevious
        if travel.minutes > 0 || travel.distanceM > 0 {
            let mode = TripWays.mode(of: stop, leg: leg)
            Button {
                wayRequest = makeWayRequest(to: stop, on: day, leg: leg, fromHere: false)
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: mode.systemImage)
                        .frame(width: 20)
                    Text(TripWays.line(minutes: travel.minutes, distanceM: travel.distanceM, by: mode))
                    if stop.wayMode != nil {
                        Image(systemName: "pin.fill")
                            .font(.caption2)
                            .accessibilityLabel("für diesen Weg gewählt")
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.leading, 18)
                .frame(minHeight: 28)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Zeigt den Weg")
        }
    }

    /// What "Weg" opens with for a spot of a day: from here on the road
    /// (where the phone knows it), else from the spot before it or the
    /// start of the day, with the arrival checked on that day.
    private func makeWayRequest(to stop: TripStop, on day: TripDay, leg: TripLeg, fromHere: Bool) -> TripWayRequest {
        let stops = TripStayPlan.stops(of: day)
        let to = TripWayRequest.End(name: stop.displayName, coordinate: stop.coordinate)
        let mode = TripWays.mode(of: stop, leg: leg)
        if fromHere, let here = CLLocationManager().location?.coordinate {
            return TripWayRequest(
                from: .init(name: "Mein Standort", coordinate: TripCoordinate(lat: here.latitude, lon: here.longitude),
                            isHere: true),
                to: to,
                check: (dayIndex: day.dayIndex, osmRef: stop.osmRef, departMinutes: TripDayTimeline.minutesOfDay(Date())),
                segment: nil,
                currentMode: mode,
            )
        }
        let index = stops.firstIndex { $0.rowId == stop.rowId }
        let previous = index.flatMap { $0 > 0 ? stops[$0 - 1] : nil }
        let from: TripWayRequest.End
        if let previous {
            from = .init(name: previous.displayName, coordinate: previous.coordinate)
        } else if let anchor = day.anchor {
            from = .init(name: anchor.label ?? "Start des Tages", coordinate: TripCoordinate(lat: anchor.lat, lon: anchor.lon))
        } else {
            from = .init(name: leg.anchorLabel ?? "Unterkunft", coordinate: leg.anchor)
        }
        let depart = stop.etaMinutes.map { max(0, $0 - stop.travelFromPrevious.minutes) }
        return TripWayRequest(
            from: from,
            to: to,
            check: depart.map { (dayIndex: day.dayIndex, osmRef: stop.osmRef, departMinutes: $0) },
            segment: (fromRef: previous?.osmRef ?? TripWays.dayStart, toRef: stop.osmRef),
            currentMode: mode,
        )
    }

    private func add(_ marker: TripStayMarker, to day: TripDay, leg: TripLeg) async {
        guard let target = TripStayPlan.dropTarget(day: day, before: nil) else { return }
        switch marker.kind {
        case .idea(let osmRef):
            guard let candidate = leg.pool.first(where: { $0.osmRef == osmRef }) else { return }
            _ = await viewModel.place(candidate, inBlock: target.blockId, onDay: day.dayIndex)
        case .stop(let rowId):
            guard let stop = TripStayPlan.stop(rowId: rowId, in: leg) else { return }
            await viewModel.move(stop, toDayIndex: day.dayIndex, toBlockId: target.blockId, position: nil)
        }
    }

    private func chip(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(selected ? .semibold : .regular))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(selected ? Color.accentColor.opacity(0.18) : Color(.secondarySystemBackground),
                            in: .capsule)
                .foregroundStyle(selected ? Color.accentColor : Color.primary)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func days(of leg: TripLeg) -> [TripDay] {
        leg.days.sorted { $0.dayIndex < $1.dayIndex }
    }
}

/// The marker tapped on the stay's map.
struct TripStayMapPick: Identifiable {
    let marker: TripStayMarker
    var id: String { marker.id }
}

/// One marker on the stay's map: a stop of a day, or an idea.
struct TripStayMarker: Identifiable {
    enum Kind: Equatable {
        case stop(rowId: Int)
        case idea(osmRef: String)
    }

    let id: String
    let kind: Kind
    let title: String
    let coordinate: CLLocationCoordinate2D
    /// The day it is on; nil for an idea.
    let dayIndex: Int?
    /// Its place in the selected day's line, from 1; nil when it is not
    /// on the selected day (or every day is shown).
    let number: Int?
    /// On another day than the one the map is showing.
    let faded: Bool
    /// Visited (stage 5): drawn with a check.
    var done: Bool = false
    /// The next spot of the day being lived, which carries "Route".
    var isNext: Bool = false
    /// Photos taken there, from the day's diary.
    var photoCount: Int = 0

    var accessibilityLabel: String {
        switch kind {
        case .idea: "Idee \(title)"
        case .stop:
            [dayIndex.map { "Tag \($0 + 1): \(title)" } ?? title,
             done ? "besucht" : nil,
             isNext ? "als Nächstes" : nil,
             photoCount > 0 ? "\(photoCount) Fotos" : nil]
                .compactMap { $0 }.joined(separator: ", ")
        }
    }
}

private struct TripStayMarkerLabel: View {
    let marker: TripStayMarker

    var body: some View {
        switch marker.kind {
        case .idea:
            // Hollow: not on a day yet.
            Circle()
                .strokeBorder(Color.accentColor, lineWidth: 2.5)
                .background(Circle().fill(Color(.systemBackground)))
                .frame(width: 22, height: 22)
        case .stop:
            Group {
                if marker.done {
                    Image(systemName: "checkmark")
                        .font(.caption.weight(.bold))
                } else {
                    Text(marker.number.map { "\($0)" } ?? marker.dayIndex.map { "\($0 + 1)" } ?? "")
                        .font(.caption.weight(.bold))
                }
            }
            .foregroundStyle(.white)
            .frame(width: marker.isNext ? 34 : 28, height: marker.isNext ? 34 : 28)
            .background(marker.done ? Color.green : Color.accentColor, in: .circle)
            .overlay(Circle().strokeBorder(.white, lineWidth: marker.isNext ? 3 : 2))
            .overlay(alignment: .topTrailing) {
                if marker.photoCount > 0 {
                    Text("\(marker.photoCount)")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 4)
                        .background(Color.black.opacity(0.7), in: .capsule)
                        .offset(x: 8, y: -6)
                }
            }
            .opacity(marker.faded ? 0.35 : 1)
        }
    }
}

/// What the stay's planning view computes, apart from the view so it
/// can be tested.
enum TripStayPlan {
    /// The days an outing of `dayIndex` can move to (the server's
    /// rules in `excursions-api.ts`): a window goes to any day that is
    /// not a whole-day trip, a whole-day trip only to a day with no
    /// outing at all.
    static func excursionMoveTargets(_ leg: TripLeg, from dayIndex: Int, wholeDay: Bool) -> [TripDayAnchorSheet.MoveTarget] {
        leg.days
            .filter { $0.dayIndex != dayIndex && $0.anchor == nil }
            .filter { !wholeDay || ($0.excursions ?? []).isEmpty }
            .sorted { $0.dayIndex < $1.dayIndex }
            .map { TripDayAnchorSheet.MoveTarget(dayIndex: $0.dayIndex, label: dayTitle($0, leg: leg)) }
    }

    /// Every stop of the day in its order, across its spots blocks.
    static func stops(of day: TripDay) -> [TripStop] {
        day.blocks.filter { $0.kind == "spots" }.flatMap(\.stops)
    }

    /// "Tag 2 · Mi, 4. Juni", or "Tag 2" without a date.
    static func dayTitle(_ day: TripDay, leg: TripLeg) -> String {
        let number = "Tag \(day.dayIndex + 1)"
        guard let date = leg.date(ofDayIndex: day.dayIndex) else { return number }
        return "\(number) · \(date)"
    }

    /// "Tag 1 · Fr 27.11. · an 12:30", "Tag 4 · Mo 30.11. · ab 10:00":
    /// the arrival shortens the first day, the departure the last.
    static func dayHeading(_ day: TripDay, leg: TripLeg) -> String {
        var heading = dayTitle(day, leg: leg)
        if day.dayIndex == 0, let arrive = leg.arriveMinutes {
            heading += " · an \(TripClock.format(arrive))"
        }
        if let departure = day.fixpoints.first(where: { leg.isJourneyDeparture($0, dayIndex: day.dayIndex) }) {
            heading += " · ab \(TripClock.format(departure.startMinutes))"
        }
        return heading
    }

    /// "4 Tage · Fr 27.11. bis Mo 30.11. · Hotel Beispiel", under the
    /// stay's name; "noch nichts gebucht" without lodging.
    static func staySubtitle(_ leg: TripLeg) -> String {
        let count = leg.days.count
        var parts = [count == 1 ? "1 Tag" : "\(count) Tage"]
        if let first = leg.date(ofDayIndex: 0), let last = leg.date(ofDayIndex: max(0, count - 1)) {
            parts.append(count > 1 ? "\(first) bis \(last)" : first)
        }
        if leg.anchorRadiusM != nil {
            parts.append("noch nichts gebucht")
        } else if let label = leg.anchorLabel, !label.isEmpty {
            parts.append(label)
        }
        return parts.joined(separator: " · ")
    }

    /// "hin 09:00 bis 09:45 · zurück ab 17:30", or "je 45 min hin und
    /// zurück" while nobody said when.
    static func dayTripLine(_ anchor: TripDayAnchor) -> String {
        guard let depart = anchor.departMinutes else {
            return "je \(TripClock.duration(anchor.travelMinutes)) hin und zurück"
        }
        var line = "hin \(TripClock.format(depart)) bis \(TripClock.format(depart + anchor.travelMinutes))"
        if let back = anchor.returnMinutes { line += " · zurück ab \(TripClock.format(back))" }
        return line
    }

    /// Where the plan has the group at `minutes`: at a spot during its
    /// visit, on the straight line between two spots on the way, at the
    /// start before the first. Nil for a day without estimated times.
    static func position(at minutes: Int, day: TripDay, leg: TripLeg) -> TripCoordinate? {
        let timed = stops(of: day).filter { $0.etaMinutes != nil }
        guard let first = timed.first, let firstEta = first.etaMinutes else { return nil }
        var previous = day.anchor?.coordinate ?? leg.anchor
        var previousEnd = min(day.window?.startMinutes ?? firstEta, firstEta)
        for stop in timed {
            let eta = stop.etaMinutes ?? previousEnd
            if minutes < eta {
                let span = max(1, eta - previousEnd)
                let share = min(1, max(0, Double(minutes - previousEnd) / Double(span)))
                return TripCoordinate(lat: previous.lat + (stop.coordinate.lat - previous.lat) * share,
                                      lon: previous.lon + (stop.coordinate.lon - previous.lon) * share)
            }
            if minutes < eta + stop.dwellMinutes { return stop.coordinate }
            previous = stop.coordinate
            previousEnd = eta + stop.dwellMinutes
        }
        return previous
    }

    /// "2 von 5 besucht", for a day on the road.
    static func visitedLine(_ day: TripDay) -> String? {
        let stops = stops(of: day)
        guard !stops.isEmpty else { return nil }
        return "\(stops.filter { $0.stopStatus == .done }.count) von \(stops.count) besucht"
    }

    /// What a card says it is, above its time: the kind of place and
    /// how long it takes ("Kirche · 1 h").
    static func kindLine(_ stop: TripStop) -> String {
        "\(TripCategory.label(stop.category)) · \(TripClock.duration(stop.dwellMinutes))"
    }

    /// The card's third line (mock "Den Aufenthalt planen"): a spot a
    /// fixed time holds says why and when ("Ticket 15:30 · gepinnt"),
    /// any other its estimated time and how much it matters
    /// ("ca. 13:45 · Muss"); "Will" is the ordinary case and says
    /// nothing.
    static func timeLine(_ stop: TripStop, pin: (reason: TripPinReason?, startMinutes: Int)?) -> String {
        if let pin {
            return "\(pin.reason?.label ?? "Fest") \(TripClock.format(pin.startMinutes)) · gepinnt"
        }
        var parts = [caption(stop)].filter { !$0.isEmpty }
        if stop.ideaPriority != .want { parts.append(stop.ideaPriority.label) }
        return parts.joined(separator: " · ")
    }

    /// True for a day the frame left no time on: the arrival comes after
    /// the day's end (19:51 on a day that ends at 19:00), so the server
    /// kept no block for spots and has no window to measure. A day of
    /// an older trip without a clock still has its blocks.
    static func hasNoTime(_ day: TripDay) -> Bool {
        day.window == nil && !day.blocks.contains { $0.kind == "spots" }
    }

    /// "3 h 20 von 9 h", "3 h 20 von 9 h, 1 h warten", "Plan bis 19:40, Tag endet 19:00",
    /// "noch frei", "keine Zeit frei",
    /// or nil for a day without a clock.
    static func fillLine(_ day: TripDay) -> String? {
        if hasNoTime(day) { return "keine Zeit frei" }
        guard let window = day.window, window.minutes > 0 else { return nil }
        if let over = day.overrunMinutes, over > 0 {
            // When the plan would end and when the day may: "zu viel"
            // alone did not say against what (Anton, 11.11.), and
            // "endet 15:30 statt 09:15" not which of the two ends where
            // (13.11.).
            return "Plan bis \(TripClock.format(window.endMinutes + over)), Tag endet \(TripClock.format(window.endMinutes))"
        }
        // Ways and visits only: standing at a door that opens later is
        // not planned. Counted in, a shorter visit changed nothing (the
        // next stop waited the longer) and a longer one only the part
        // past the wait (Anton, 14.11.); the wait stands beside it.
        let planned = day.plannedMinutes ?? 0
        let wait = day.waitMinutes ?? 0
        if planned == 0 && wait == 0 { return "noch frei" }
        let line = "\(TripClock.duration(planned)) von \(TripClock.duration(window.minutes))"
        return wait > 0 ? line + ", \(TripClock.duration(wait)) warten" : line
    }

    /// Planned over available, for the fill mark; nil without a clock.
    static func fill(_ day: TripDay) -> Double? {
        guard let window = day.window, window.minutes > 0 else { return nil }
        if let over = day.overrunMinutes, over > 0 { return 1 + Double(over) / Double(window.minutes) }
        let planned = (day.plannedMinutes ?? 0) + (day.waitMinutes ?? 0)
        return Double(planned) / Double(window.minutes)
    }

    /// "ca. 10:30 · 1 h 30" — the estimated start, then the duration.
    static func caption(_ stop: TripStop) -> String {
        var parts: [String] = []
        if let eta = stop.etaMinutes { parts.append("ca. \(TripClock.format(eta))") }
        if let wait = stop.waitMinutes, wait > 0 { parts.append("\(TripClock.duration(wait)) warten") }
        if stop.outsideHours == true { parts.append("dann geschlossen") }
        return parts.joined(separator: " · ")
    }

    static func dragId(_ stop: TripStop) -> String { "trip-stop:\(stop.rowId)" }

    /// An outing dragged onto another day: its day and, for a window,
    /// its id ("trip-excursion:2:ab12cd34"; empty for a whole-day trip).
    static func excursionDragId(dayIndex: Int, excursionId: String?) -> String {
        "trip-excursion:\(dayIndex):\(excursionId ?? "")"
    }

    static func excursion(fromDragId id: String) -> (dayIndex: Int, excursionId: String?)? {
        guard id.hasPrefix("trip-excursion:") else { return nil }
        let parts = id.dropFirst("trip-excursion:".count).split(separator: ":", maxSplits: 1,
                                                                 omittingEmptySubsequences: false)
        guard let first = parts.first, let dayIndex = Int(first) else { return nil }
        let excursionId = parts.count > 1 && !parts[1].isEmpty ? String(parts[1]) : nil
        return (dayIndex, excursionId)
    }

    static func rowId(fromDragId id: String) -> Int? {
        guard id.hasPrefix("trip-stop:") else { return nil }
        return Int(id.dropFirst("trip-stop:".count))
    }

    static func stop(rowId: Int, in leg: TripLeg) -> TripStop? {
        for day in leg.days {
            for block in day.blocks {
                if let stop = block.stops.first(where: { $0.rowId == rowId }) { return stop }
            }
        }
        return nil
    }

    /// Where a drop lands: the spots block holding the card at `before`
    /// (counted across the day's spots blocks) at its place in that
    /// block, or the end of the day's last spots block. Nil for a day
    /// without a spots block.
    /// The spots blocks of a day in order, each with its first number.
    static func sections(of day: TripDay) -> [TripStaySection] {
        var offset = 0
        return day.blocks.filter { $0.kind == "spots" }.map { block in
            defer { offset += block.stops.count }
            return TripStaySection(block: block, offset: offset, excursion: day.excursion(ofBlock: block.id))
        }
    }

    static func dropTarget(day: TripDay, before: Int?) -> (blockId: String, position: Int?)? {
        let blocks = day.blocks.filter { $0.kind == "spots" }
        guard let last = blocks.last else { return nil }
        // The end of the day is the day at the quarters, not the last
        // excursion's window (Mock 16).
        guard let before else { return ((blocks.last { day.excursion(ofBlock: $0.id) == nil } ?? last).id, nil) }
        var remaining = before
        for block in blocks {
            if remaining < block.stops.count { return (block.id, remaining) }
            remaining -= block.stops.count
        }
        return (last.id, nil)
    }

    /// The map's markers: the selected day numbered in its order, the
    /// other days faded, the ideas hollow when shown.
    static func markers(leg: TripLeg, selectedDay: Int?, ideas: Bool, nextRowId: Int? = nil,
                        photoCounts: [Int: Int] = [:]) -> [TripStayMarker] {
        var out: [TripStayMarker] = []
        for day in leg.days.sorted(by: { $0.dayIndex < $1.dayIndex }) {
            for (index, stop) in stops(of: day).enumerated() {
                let onSelected = selectedDay == day.dayIndex
                out.append(TripStayMarker(
                    id: "stop-\(stop.rowId)",
                    kind: .stop(rowId: stop.rowId),
                    title: stop.displayName,
                    coordinate: CLLocationCoordinate2D(latitude: stop.lat, longitude: stop.lon),
                    dayIndex: day.dayIndex,
                    number: onSelected ? index + 1 : nil,
                    faded: selectedDay != nil && !onSelected,
                    done: stop.stopStatus == .done,
                    isNext: stop.rowId == nextRowId,
                    photoCount: photoCounts[stop.rowId] ?? 0,
                ))
            }
        }
        if ideas {
            for candidate in leg.pool {
                out.append(TripStayMarker(
                    id: "idea-\(candidate.osmRef)",
                    kind: .idea(osmRef: candidate.osmRef),
                    title: candidate.displayName,
                    coordinate: CLLocationCoordinate2D(latitude: candidate.lat, longitude: candidate.lon),
                    dayIndex: nil,
                    number: nil,
                    faded: false,
                ))
            }
        }
        return out
    }
}

/// What the "⋯" of a day in the stay's planning view asks the host for.
enum TripStayDayAction {
    case order
    case pause(TripBreakPreset)
    case fixedTime
    case dayTrip
    /// Change an excursion's hours or place (Mock 16).
    case excursion(TripExcursion)
    /// Add a destination that goes on from this excursion (Mock 18).
    case appendExcursion(TripExcursion)
}

/// An excursion and its day, for the picker and the removal question.
/// What the spot picker opens on: the stay, a day at the quarters, a
/// day out, or an excursion's window.
struct TripPickerRequest: Identifiable {
    let id = UUID()
    var dayTrip: Int?
    var excursion: TripExcursionPick?
    var day: Int?
}

struct TripExcursionPick: Equatable {
    let dayIndex: Int
    let excursion: TripExcursion
}

/// A spots block of a day and where its stops start in the day's
/// numbering; an excursion's block carries its excursion.
struct TripStaySection: Identifiable {
    let block: TripBlock
    let offset: Int
    let excursion: TripExcursion?
    var id: String { block.id }
}

/// Where a dragged card would land in the stay's planning view.
struct TripDropSlot: Equatable {
    let dayIndex: Int
    /// The index of the card it goes in front of; nil is the day's end.
    let before: Int?
}

/// A card that can be dragged and dropped on: lifts with its name,
/// takes a drop in front of itself.
struct TripReorderable: ViewModifier {
    let id: String
    let name: String
    let slot: TripDropSlot
    @Binding var current: TripDropSlot?
    let perform: ([String]) -> Bool

    func body(content: Content) -> some View {
        content
            .onDrag {
                NSItemProvider(object: id as NSString)
            } preview: {
                Text(name)
                    .font(.subheadline.weight(.semibold))
                    .padding(8)
                    .background(.regularMaterial, in: .rect(cornerRadius: 8))
            }
            .onDrop(of: [.plainText], delegate: TripStopDropDelegate(slot: slot, current: $current, perform: perform))
    }
}

/// A drop on the stay's planning view: says "move" (no "+" badge),
/// keeps the line where the card would go, and hands the dragged id on.
struct TripStopDropDelegate: DropDelegate {
    let slot: TripDropSlot
    @Binding var current: TripDropSlot?
    let perform: ([String]) -> Bool

    func validateDrop(info: DropInfo) -> Bool {
        info.hasItemsConforming(to: [.plainText])
    }

    func dropEntered(info: DropInfo) {
        withAnimation(.easeOut(duration: 0.12)) { current = slot }
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        if current != slot { current = slot }
        return DropProposal(operation: .move)
    }

    func dropExited(info: DropInfo) {
        if current == slot { withAnimation(.easeOut(duration: 0.12)) { current = nil } }
    }

    func performDrop(info: DropInfo) -> Bool {
        let providers = info.itemProviders(for: [.plainText])
        guard let provider = providers.first else {
            current = nil
            return false
        }
        _ = provider.loadObject(ofClass: NSString.self) { object, _ in
            let id = (object as? NSString).map { String($0) }
            Task { @MainActor in
                current = nil
                if let id { _ = perform([id]) }
            }
        }
        return true
    }
}

/// A card swiped to the left shows "Löschen" behind it; a long swipe or
/// a tap on it deletes. The cards stand in a scroll view, not a `List`,
/// so `swipeActions` is not there to use; this is the same gesture.
struct TripSwipeToDelete: ViewModifier {
    let enabled: Bool
    /// Called as soon as a drag is sideways, so the card's own tap,
    /// which ends with the same finger, can stand down.
    var onSwipe: () -> Void = {}
    let perform: () -> Void

    /// A tap within this long after a sideways drag was the drag.
    static func justSwiped(_ at: Date?, now: Date = Date()) -> Bool {
        guard let at else { return false }
        return now.timeIntervalSince(at) < 0.5
    }

    @State private var offset: CGFloat = 0
    @State private var open = false
    private let button: CGFloat = 88

    func body(content: Content) -> some View {
        if !enabled {
            content
        } else {
            content
                .offset(x: offset)
                .background(alignment: .trailing) {
                    if offset < 0 {
                        Button(role: .destructive) {
                            withAnimation(.snappy) { offset = 0; open = false }
                            perform()
                        } label: {
                            Label("Löschen", systemImage: "trash")
                                .labelStyle(.iconOnly)
                                .font(.title3)
                                .foregroundStyle(.white)
                                .frame(width: max(button, -offset), alignment: .center)
                                .frame(maxHeight: .infinity)
                                .background(Color.red, in: .rect(cornerRadius: 12))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Löschen")
                    }
                }
                .simultaneousGesture(
                    DragGesture(minimumDistance: 20)
                        .onChanged { value in
                            // Only a sideways drag; a vertical one scrolls.
                            guard abs(value.translation.width) > abs(value.translation.height) else { return }
                            onSwipe()
                            let base: CGFloat = open ? -button : 0
                            offset = min(0, base + value.translation.width)
                        }
                        .onEnded { value in
                            guard abs(value.translation.width) > abs(value.translation.height) else {
                                withAnimation(.snappy) { offset = open ? -button : 0 }
                                return
                            }
                            let width = value.translation.width + (open ? -button : 0)
                            withAnimation(.snappy) {
                                if width < -240 {
                                    offset = 0
                                    open = false
                                    perform()
                                } else if width < -button / 2 {
                                    offset = -button
                                    open = true
                                } else {
                                    offset = 0
                                    open = false
                                }
                            }
                        },
                )
                // While "Löschen" shows, a tap on the card closes it, as
                // in a list, instead of reaching the card.
                .overlay {
                    if open {
                        Color.clear
                            .contentShape(.rect)
                            .offset(x: offset)
                            .onTapGesture { withAnimation(.snappy) { offset = 0; open = false } }
                    }
                }
                .accessibilityAction(named: "Löschen", perform)
        }
    }
}

/// The stay whose sheet is open from its days.
struct TripStayEditing: Identifiable {
    let id: TripItineraryItem.ID
    let draft: TripItineraryDraft
}
