import MapKit
import SwiftUI

/// The itinerary as a map (reise-planen-und-unterwegs.md, "Maps",
/// variant A): a numbered marker per stay, a line per journey — dashed
/// while its times are open, a great circle for a flight — and the
/// selected stay's card below with its days and "Planen". Swiping the
/// card selects the next stay; a tapped marker selects its stay.
///
/// A journey with stops on the way runs through them, each a small
/// marker on its line, and has a card of its own between the stays
/// (Anton, 17.11.): its stops with their times, a tap opens one.
struct TripItineraryMapView: View {
    let draft: TripItineraryDraft
    let plan: TripPlan?
    @Binding var selected: TripItineraryItem.ID?
    let onPlan: (TripItineraryItem, Int?) -> Void
    /// A stop on the way tapped, on the map or on its journey's card.
    var onStop: (TripStop, TripLeg) -> Void = { _, _ in }
    /// "Bearbeiten" on a journey's card: its sheet.
    var onJourney: (TripItineraryItem.ID) -> Void = { _ in }

    @State private var position: MapCameraPosition = .automatic

    private var stays: [TripItineraryItem] { draft.stays.filter { $0.anchor != nil } }

    /// The cards in the order of the trip: every stay with a place, and
    /// between them the journeys that stop on the way.
    private var cards: [TripItineraryItem] {
        draft.items.filter { item in
            item.isStay ? item.anchor != nil : !(stopLeg(of: item)?.stopsOnTheWay.isEmpty ?? true)
        }
    }

    /// The journey's own leg, when one can stop on it.
    private func stopLeg(of journey: TripItineraryItem) -> TripLeg? {
        guard journey.isJourney, let legId = journey.legId,
              let leg = plan?.legs.first(where: { $0.id == legId }), leg.isStoppable
        else { return nil }
        return leg
    }

    var body: some View {
        VStack(spacing: 0) {
            Map(position: $position) {
                ForEach(lines) { line in
                    MapPolyline(coordinates: line.points,
                                contourStyle: line.mode == .plane ? .geodesic : .straight)
                        .stroke(Color.accentColor.opacity(0.8),
                                style: StrokeStyle(lineWidth: 3, lineCap: .round,
                                                   dash: line.timed ? [] : [6, 5]))
                }
                if let home = plan?.home, draft.hasHome {
                    Annotation("Zuhause", coordinate: CLLocationCoordinate2D(latitude: home.lat, longitude: home.lon)) {
                        Image(systemName: "house.fill")
                            .font(.caption)
                            .foregroundStyle(.white)
                            .frame(width: 26, height: 26)
                            .background(Color.secondary, in: .circle)
                    }
                }
                ForEach(stopMarkers) { marker in
                    Annotation(marker.stop.displayName, coordinate: marker.coordinate) {
                        Button {
                            withAnimation(.snappy) { selected = marker.journeyId }
                            onStop(marker.stop, marker.leg)
                        } label: {
                            Image(systemName: "mappin")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.white)
                                .frame(width: 22, height: 22)
                                .background(selected == marker.journeyId ? Color.orange : Color.orange.opacity(0.7),
                                            in: .circle)
                                .overlay(Circle().strokeBorder(.white, lineWidth: 1.5))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Halt unterwegs: \(marker.stop.displayName)")
                    }
                }
                ForEach(markers) { marker in
                    Annotation(marker.title, coordinate: marker.coordinate) {
                        Button {
                            withAnimation(.snappy) { selected = marker.id }
                        } label: {
                            Text("\(marker.number)")
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(.white)
                                .frame(width: 30, height: 30)
                                .background(selected == marker.id ? Color.accentColor : Color.accentColor.opacity(0.6),
                                            in: .circle)
                                .overlay(Circle().strokeBorder(.white, lineWidth: 2))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(marker.number). \(marker.title)")
                    }
                }
            }
            .mapStyle(.standard(pointsOfInterest: .excludingAll))

            if !cards.isEmpty {
                TabView(selection: Binding(
                    get: { selected ?? cards.first?.id },
                    set: { id in withAnimation(.snappy) { selected = id } },
                )) {
                    ForEach(cards) { item in
                        Group {
                            if let leg = stopLeg(of: item) {
                                journeyCard(item, leg: leg)
                            } else {
                                card(item, number: (stays.firstIndex { $0.id == item.id } ?? 0) + 1)
                            }
                        }
                        .padding(.horizontal, 16)
                        .tag(Optional(item.id))
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: cards.count > 1 ? .always : .never))
                .indexViewStyle(.page(backgroundDisplayMode: .always))
                .frame(height: 250)
                .background(.background)
            }
        }
        .onChange(of: selected) { _, id in
            if let id, let line = lines.first(where: { $0.id == id }), line.points.count > 2 {
                withAnimation { position = .rect(Self.rect(around: line.points)) }
                return
            }
            guard let id, let anchor = draft[id]?.anchor else { return }
            withAnimation {
                position = .camera(MapCamera(
                    centerCoordinate: CLLocationCoordinate2D(latitude: anchor.lat, longitude: anchor.lon),
                    distance: 400_000))
            }
        }
    }

    private func card(_ stay: TripItineraryItem, number: Int) -> some View {
        let dated = draft.dated().first { $0.item.id == stay.id }
        let leg = stay.legId.flatMap { id in plan?.legs.first { $0.id == id } }
        let arrival = draft.journey(before: stay.id)?.arriveAt ?? (draft.ownsStart(stay.id) ? stay.arriveAt : nil)
        let rows = dated.map {
            TripItineraryDays.rows(stay: stay, dated: $0, days: leg?.days ?? [], arrival: arrival,
                                   departure: draft.journey(after: stay.id)?.departAt)
        } ?? []
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(number). \(draft.title(of: stay))")
                    .font(.headline)
                Spacer()
                Button("Planen") { onPlan(stay, nil) }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
            }
            Text(TripItineraryText.stayLength(days: stay.days ?? 1))
                .font(.caption)
                .foregroundStyle(.secondary)
            ForEach(rows.prefix(4)) { row in
                Button {
                    onPlan(stay, row.dayIndex)
                } label: {
                    HStack {
                        Text(row.label)
                            .font(.subheadline)
                            .lineLimit(1)
                        Spacer()
                        Text(row.summary)
                            .font(.caption)
                            .foregroundStyle(row.isOverfull ? Color.red : Color.secondary)
                        TripDayFillMark(fill: row.fill ?? 0)
                            .frame(width: 48)
                            .opacity(row.noTime ? 0 : 1)
                    }
                    .frame(minHeight: 30)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
            }
            if rows.count > 4 {
                Text("und \(rows.count - 4) weitere Tage")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.top, 12)
    }

    /// A journey's card: where from and where to, its stops on the way
    /// with their times, each opening its details.
    private func journeyCard(_ journey: TripItineraryItem, leg: TripLeg) -> some View {
        let ends = draft.ends(of: journey)
        let stops = leg.stopsOnTheWay
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Label("\(ends.from) → \(ends.to)", systemImage: journey.transportMode.systemImage)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                Button("Bearbeiten") { onJourney(journey.id) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
            Text(timesLine(journey, stops: stops.count))
                .font(.caption)
                .foregroundStyle(.secondary)
            ForEach(stops.prefix(4), id: \.rowId) { stop in
                Button {
                    onStop(stop, leg)
                } label: {
                    HStack {
                        Image(systemName: "mappin")
                            .font(.caption)
                            .foregroundStyle(.orange)
                        Text(stop.displayName)
                            .font(.subheadline)
                            .lineLimit(1)
                        Spacer()
                        Text(TripItineraryStops.line(stop))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(minHeight: 30)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
            }
            if stops.count > 4 {
                Text("und \(stops.count - 4) weitere Halte")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.top, 12)
    }

    /// "ab 09:00 · an 17:30 · 2 Halte".
    private func timesLine(_ journey: TripItineraryItem, stops: Int) -> String {
        var parts: [String] = [draft.name(of: journey)]
        if let depart = journey.departAt { parts.append("ab \(depart)") }
        if let arrive = journey.arriveAt { parts.append("an \(arrive)") }
        parts.append(stops == 1 ? "1 Halt" : "\(stops) Halte")
        return parts.joined(separator: " · ")
    }

    /// A stop on the way, on the line of its journey.
    private struct StopMarker: Identifiable {
        let stop: TripStop
        let leg: TripLeg
        let journeyId: TripItineraryItem.ID
        var id: Int { stop.rowId }
        var coordinate: CLLocationCoordinate2D {
            CLLocationCoordinate2D(latitude: stop.lat, longitude: stop.lon)
        }
    }

    private var stopMarkers: [StopMarker] {
        draft.items.flatMap { item -> [StopMarker] in
            guard let leg = stopLeg(of: item) else { return [] }
            return leg.stopsOnTheWay.map { StopMarker(stop: $0, leg: leg, journeyId: item.id) }
        }
    }

    /// The map's frame around a journey and its stops, with a margin.
    static func rect(around points: [CLLocationCoordinate2D]) -> MKMapRect {
        let rects = points.map { MKMapRect(origin: MKMapPoint($0), size: MKMapSize(width: 0, height: 0)) }
        let union = rects.dropFirst().reduce(rects.first ?? .null) { $0.union($1) }
        let margin = max(union.size.width, union.size.height) * 0.25 + 2_000
        return union.insetBy(dx: -margin, dy: -margin)
    }

    /// One numbered marker per stay with a place.
    private struct StayMarker: Identifiable {
        let id: TripItineraryItem.ID
        let number: Int
        let title: String
        let coordinate: CLLocationCoordinate2D
    }

    private var markers: [StayMarker] {
        stays.enumerated().compactMap { number, stay in
            guard let anchor = stay.anchor else { return nil }
            return StayMarker(id: stay.id, number: number + 1, title: draft.title(of: stay),
                              coordinate: CLLocationCoordinate2D(latitude: anchor.lat, longitude: anchor.lon))
        }
    }

    /// One line per journey whose two ends have a place.
    private struct Line: Identifiable {
        let id: TripItineraryItem.ID
        /// From, the stops on the way in their order, to.
        let points: [CLLocationCoordinate2D]
        let mode: TripTransportMode
        let timed: Bool
    }

    private var lines: [Line] {
        let home = plan?.home.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon) }
        let point = { (item: TripItineraryItem?) -> CLLocationCoordinate2D? in
            guard let item else { return home }
            return item.anchor.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon) }
        }
        return draft.items.compactMap { item in
            guard item.isJourney,
                  let from = point(draft.stay(before: item.id)),
                  let to = point(draft.stay(after: item.id))
            else { return nil }
            let via = (stopLeg(of: item)?.stopsOnTheWay ?? []).map {
                CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon)
            }
            return Line(id: item.id, points: [from] + via + [to], mode: item.transportMode, timed: item.isTimed)
        }
    }
}
