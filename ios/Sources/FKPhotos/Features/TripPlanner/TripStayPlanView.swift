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

    @AppStorage("trip.stayPlan.layout") private var layout = Layout.list.rawValue
    /// The day the map shows numbered; nil is every day.
    @State private var mapDay: Int?
    @State private var showIdeasOnMap = true
    /// The marker tapped on the map, for its "+ Tag n".
    @State private var picked: TripStayMapPick?
    /// The card being dragged, so the day it hovers over can say so.
    @State private var targetedDay: Int?

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
        .navigationTitle(viewModel.leg?.displayTitle ?? "Aufenthalt")
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
        }
        .plannerErrorBanner(viewModel.errorMessage, retry: { await viewModel.load() },
                            dismiss: { viewModel.errorMessage = nil })
    }

    // MARK: - List

    private func list(_ leg: TripLeg) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                ForEach(days(of: leg)) { day in
                    daySection(day, leg: leg)
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
    }

    private func daySection(_ day: TripDay, leg: TripLeg) -> some View {
        let stops = TripStayPlan.stops(of: day)
        return VStack(alignment: .leading, spacing: 8) {
            Button {
                openDay(day.dayIndex)
            } label: {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(TripStayPlan.dayTitle(day, leg: leg))
                            .font(.headline)
                        Spacer()
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

            if stops.isEmpty {
                Text("Spot hierher ziehen oder aus den Ideen hinzufügen")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, minHeight: 72)
                    .background {
                        RoundedRectangle(cornerRadius: 12)
                            .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [6, 4]))
                            .foregroundStyle(targetedDay == day.dayIndex ? Color.accentColor : Color.secondary.opacity(0.5))
                    }
            } else {
                ForEach(Array(stops.enumerated()), id: \.element.id) { index, stop in
                    card(stop, day: day, number: index + 1)
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

    private func card(_ stop: TripStop, day: TripDay, number: Int) -> some View {
        let visit = viewModel.visit(holding: stop, onDay: day.dayIndex)
        return HStack(alignment: .top, spacing: 10) {
            NavigationLink {
                TripSpotDetailView(
                    spot: TripSpotDetail(stop),
                    mode: viewModel.leg?.transportMode ?? .foot,
                    onSave: { await viewModel.saveNote($0) },
                    light: nil,
                    shelter: nil,
                ) { closeDetail in
                    TripSpotActionSections(
                        actions: stopActions(stop).filter { $0.group != .navigate },
                        close: closeDetail,
                    )
                }
            } label: {
                HStack(alignment: .top, spacing: 10) {
                    if let image = stop.image {
                        TripSpotThumbnail(image: image, height: 56, width: 56)
                    } else {
                        Text("\(number)")
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
                        Text(TripStayPlan.caption(stop))
                            .font(.caption)
                            .foregroundStyle(stop.outsideHours == true ? Color.red : Color.secondary)
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
        .padding(10)
        .background(Color(.systemBackground), in: .rect(cornerRadius: 10))
        .opacity(stop.stopStatus == .planned ? 1 : 0.6)
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
        let markers = TripStayPlan.markers(leg: leg, selectedDay: mapDay, ideas: showIdeasOnMap)
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
                            picked = TripStayMapPick(marker: marker)
                        } label: {
                            TripStayMarkerLabel(marker: marker)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(marker.accessibilityLabel)
                    }
                }
            }
            .mapStyle(.standard(pointsOfInterest: .excludingAll))
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

    @ViewBuilder
    private func pickActions(_ marker: TripStayMarker, leg: TripLeg) -> some View {
        let targets = days(of: leg).filter { $0.dayIndex != marker.dayIndex }
        let preferred = mapDay.flatMap { index in targets.first { $0.dayIndex == index } }
        ForEach(preferred.map { [$0] } ?? targets) { day in
            Button("+ Tag \(day.dayIndex + 1)") {
                Task { await add(marker, to: day, leg: leg) }
            }
        }
        if let dayIndex = marker.dayIndex {
            Button("Tag \(dayIndex + 1) öffnen") { openDay(dayIndex) }
        }
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

    var accessibilityLabel: String {
        switch kind {
        case .idea: "Idee \(title)"
        case .stop: dayIndex.map { "Tag \($0 + 1): \(title)" } ?? title
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
            Text(marker.number.map { "\($0)" } ?? marker.dayIndex.map { "\($0 + 1)" } ?? "")
                .font(.caption.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 28, height: 28)
                .background(Color.accentColor, in: .circle)
                .overlay(Circle().strokeBorder(.white, lineWidth: 2))
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
    static func markers(leg: TripLeg, selectedDay: Int?, ideas: Bool) -> [TripStayMarker] {
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
