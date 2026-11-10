import CoreLocation
import MapKit
import SwiftUI

/// A stay planned as a whole (reise-planen-und-unterwegs.md, stage 3):
/// every day of it on one screen, each with what it holds as cards —
/// picture, name, estimated time, duration, priority, a fixed time with
/// its reason — and "verplant von verfügbar" in its header.
///
/// A card is dragged onto another card to stand before it, or onto a
/// day to go to its end; an empty day is a drop zone of its own. The
/// "⋯" on a card holds the same actions as the day's rows, the map's
/// sheet and the detail screen (CLAUDE.md, "Aktionen an Spots"); a tap
/// opens the details. "Liste | Karte" shows the same days on a map with
/// day chips.
struct TripStayPlanView: View {
    @State var viewModel: TripPlannerViewModel
    /// The actions of a stop, from the one place that builds them.
    let stopActions: (TripStop) -> [TripPinSheetAction]
    /// Opens the day on its own screen (the band, the order, the breaks).
    let openDay: (Int) -> Void
    /// The screen's title when it is the trip's first screen (the
    /// trip's name); otherwise the stay's.
    var title: String? = nil

    @AppStorage("trip.stayPlan.layout") private var layout = Layout.list.rawValue
    /// The day the map shows numbered; nil is every day.
    @State private var mapDay: Int?
    @State private var showIdeasOnMap = true
    /// The marker tapped on the map, for its "+ Tag n".
    @State private var picked: TripStayMapPick?
    /// The card being dragged, so the day it hovers over can say so.
    @State private var targetedDay: Int?
    /// The card whose details are open, as a sheet over the days (stage 4).
    @State private var detailPick: TripStayDetailPick?
    /// The spot picker (stage 4).
    @State private var picking = false
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

    private struct WeatherUndo: Equatable {
        let sentence: String
        let opId: Int
    }

    private enum Layout: String { case list, map }

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
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("Ansicht", selection: $layout) {
                    Text("Liste").tag(Layout.list.rawValue)
                    Text("Karte").tag(Layout.map.rawValue)
                }
                .pickerStyle(.segmented)
                .frame(width: 180)
            }
            ToolbarItem(placement: .primaryAction) {
                Button("Spot hinzufügen", systemImage: "plus") { picking = true }
            }
        }
        .sheet(isPresented: $picking) {
            TripSpotPickerView(viewModel: viewModel)
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
                if !leg.pool.isEmpty {
                    Text(leg.pool.count == 1 ? "1 Idee wartet auf einen Tag"
                                             : "\(leg.pool.count) Ideen warten auf einen Tag")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(16)
        }
        .background(Color(.systemGroupedBackground))
        // On the road the stay opens on the day being lived.
        .onAppear {
            if let running { proxy.scrollTo(running.dayIndex, anchor: .top) }
        }
        }
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
            Button {
                openDay(day.dayIndex)
            } label: {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(TripStayPlan.dayTitle(day, leg: leg))
                            .font(.headline)
                        if phase == .running {
                            Text("Heute")
                                .font(.caption.weight(.semibold))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.accentColor.opacity(0.15), in: .capsule)
                                .foregroundStyle(Color.accentColor)
                        }
                        Spacer()
                        if let weather = viewModel.stayForecast(dayIndex: day.dayIndex)?.overall {
                            Label(weather.summary, systemImage: weather.symbolName)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .labelStyle(.titleAndIcon)
                        }
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    if let line = TripStayPlan.fillLine(day) {
                        Text(line)
                            .font(.caption)
                            .foregroundStyle((day.overrunMinutes ?? 0) > 0 ? Color.red : Color.secondary)
                    }
                    if let fill = TripStayPlan.fill(day) {
                        TripDayFillMark(fill: fill)
                    }
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Öffnet den Tag")

            if phase != .past, let note = weatherNotes.first(where: { $0.dayIndex == day.dayIndex }) {
                TripWeatherNoteCard(note: note, leg: leg, busy: applyingNote == note.dayIndex,
                                    swap: { swapping = note },
                                    moveOutdoor: { Task { await applyNote(note, kind: "outdoor") } })
            }

            if stops.isEmpty {
                Button {
                    picking = true
                } label: {
                    Text("Spot hierher ziehen oder hinzufügen")
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
                            .foregroundStyle(targetedDay == day.dayIndex ? Color.accentColor : Color.secondary.opacity(0.5))
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
                    wayLine(to: stop, on: day, leg: leg)
                    card(stop, day: day, number: index + 1,
                         mode: .open(isNext: stop.rowId == next?.rowId, canCheck: phase == .running),
                         diary: nil)
                        .draggable(TripStayPlan.dragId(stop)) {
                            Text(stop.displayName)
                                .font(.subheadline.weight(.semibold))
                                .padding(8)
                                .background(.regularMaterial, in: .rect(cornerRadius: 8))
                        }
                        .dropDestination(for: String.self) { items, _ in
                            drop(items, onDay: day, before: stops.firstIndex { $0.rowId == stop.rowId })
                        }
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
            } else {
                ForEach(Array(stops.enumerated()), id: \.element.id) { index, stop in
                    wayLine(to: stop, on: day, leg: leg)
                    card(stop, day: day, number: index + 1, mode: .plan, diary: nil)
                        .draggable(TripStayPlan.dragId(stop)) {
                            Text(stop.displayName)
                                .font(.subheadline.weight(.semibold))
                                .padding(8)
                                .background(.regularMaterial, in: .rect(cornerRadius: 8))
                        }
                        .dropDestination(for: String.self) { items, _ in
                            drop(items, onDay: day, before: index)
                        }
                }
            }
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 14))
        .overlay {
            if targetedDay == day.dayIndex {
                RoundedRectangle(cornerRadius: 14).strokeBorder(Color.accentColor, lineWidth: 2)
            }
        }
        .dropDestination(for: String.self) { items, _ in
            drop(items, onDay: day, before: nil)
        } isTargeted: { targeted in
            if targeted {
                targetedDay = day.dayIndex
            } else if targetedDay == day.dayIndex {
                targetedDay = nil
            }
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
            HStack(alignment: .top, spacing: 10) {
                checkControl(stop, mode: mode)
                Button {
                    detailPick = TripStayDetailPick(stop: stop, dayIndex: day.dayIndex)
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        if let image = stop.image {
                            TripSpotThumbnail(image: image, height: 56, width: 56)
                        } else {
                            Text(number.map { "\($0)" } ?? "")
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(.white)
                                .frame(width: 56, height: 56)
                                .background(Color.accentColor.opacity(0.7), in: .rect(cornerRadius: 8))
                        }
                        VStack(alignment: .leading, spacing: 3) {
                            Text(TripSpotName.line(stop.displayName, local: stop.localName))
                                .font(.subheadline.weight(.semibold))
                                .strikethrough(stop.stopStatus == .skipped)
                                .lineLimit(2)
                            if case .settled = mode {
                                settledLine(stop, diary: diary)
                            } else {
                                Text(TripStayPlan.caption(stop))
                                    .font(.caption)
                                    .foregroundStyle(stop.outsideHours == true ? Color.red : Color.secondary)
                                if let extent = stop.extent {
                                    Label(extent.summary, systemImage: "point.topleft.down.to.point.bottomright.curvepath")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            HStack(spacing: 6) {
                                if let visit {
                                    TripPinChip(reason: visit.reason, startMinutes: visit.startMinutes)
                                }
                                TripIdeaChips(priority: stop.ideaPriority,
                                              closedThatDay: stop.closedThatDay == true,
                                              openingHours: stop.openingHours)
                            }
                        }
                        Spacer(minLength: 0)
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
        .padding(10)
        .background(Color(.systemBackground), in: .rect(cornerRadius: 10))
        .overlay {
            if isNext {
                RoundedRectangle(cornerRadius: 10).strokeBorder(Color.accentColor, lineWidth: 2)
            }
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
        targetedDay = nil
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
        }
        .confirmationDialog(picked?.marker.title ?? "", isPresented: Binding(
            get: { picked != nil },
            set: { if !$0 { picked = nil } },
        ), titleVisibility: .visible) {
            if let pick = picked {
                pickActions(pick.marker, leg: leg)
            }
        }
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

    @ViewBuilder
    private func pickActions(_ marker: TripStayMarker, leg: TripLeg) -> some View {
        let targets = days(of: leg).filter { $0.dayIndex != marker.dayIndex }
        let preferred = mapDay.flatMap { index in targets.first { $0.dayIndex == index } }
        ForEach(preferred.map { [$0] } ?? targets) { day in
            Button("+ Tag \(day.dayIndex + 1)") {
                Task { await add(marker, to: day, leg: leg) }
            }
        }
        if marker.isNext, case .stop(let rowId) = marker.kind, let stop = TripStayPlan.stop(rowId: rowId, in: leg) {
            Button("Route") {
                if let day = leg.days.first(where: { $0.dayIndex == marker.dayIndex }) {
                    wayRequest = makeWayRequest(to: stop, on: day, leg: leg, fromHere: true)
                }
            }
        }
        if let dayIndex = marker.dayIndex {
            Button("Tag \(dayIndex + 1) öffnen") { openDay(dayIndex) }
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

    /// "3 h 20 von 9 h verplant", "40 min zu viel", or nil for a day
    /// without a clock.
    static func fillLine(_ day: TripDay) -> String? {
        guard let window = day.window, window.minutes > 0 else { return nil }
        if let over = day.overrunMinutes, over > 0 {
            return "\(TripClock.duration(over)) zu viel"
        }
        let planned = (day.plannedMinutes ?? 0) + (day.waitMinutes ?? 0)
        if planned == 0 { return "noch frei · \(TripClock.duration(window.minutes))" }
        return "\(TripClock.duration(planned)) von \(TripClock.duration(window.minutes)) verplant"
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
        parts.append(TripClock.duration(stop.dwellMinutes))
        if let wait = stop.waitMinutes, wait > 0 { parts.append("\(TripClock.duration(wait)) warten") }
        if stop.outsideHours == true { parts.append("dann geschlossen") }
        return parts.joined(separator: " · ")
    }

    static func dragId(_ stop: TripStop) -> String { "trip-stop:\(stop.rowId)" }

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
    static func dropTarget(day: TripDay, before: Int?) -> (blockId: String, position: Int?)? {
        let blocks = day.blocks.filter { $0.kind == "spots" }
        guard let last = blocks.last else { return nil }
        guard let before else { return (last.id, nil) }
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
