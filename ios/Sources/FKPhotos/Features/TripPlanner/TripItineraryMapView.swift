import MapKit
import SwiftUI

/// The itinerary as a map (reise-planen-und-unterwegs.md, "Maps",
/// variant A): a numbered marker per stay, a line per journey — dashed
/// while its times are open, a great circle for a flight — and the
/// selected stay's card below with its days and "Planen". Swiping the
/// card selects the next stay; a tapped marker selects its stay.
struct TripItineraryMapView: View {
    let draft: TripItineraryDraft
    let plan: TripPlan?
    @Binding var selected: TripItineraryItem.ID?
    let onPlan: (TripItineraryItem, Int?) -> Void

    @State private var position: MapCameraPosition = .automatic

    private var stays: [TripItineraryItem] { draft.stays.filter { $0.anchor != nil } }

    var body: some View {
        VStack(spacing: 0) {
            Map(position: $position) {
                ForEach(lines) { line in
                    MapPolyline(coordinates: [line.from, line.to],
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

            if !stays.isEmpty {
                TabView(selection: Binding(
                    get: { selected ?? stays.first?.id },
                    set: { id in withAnimation(.snappy) { selected = id } },
                )) {
                    ForEach(Array(stays.enumerated()), id: \.element.id) { number, stay in
                        card(stay, number: number + 1)
                            .padding(.horizontal, 16)
                            .tag(Optional(stay.id))
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: stays.count > 1 ? .always : .never))
                .indexViewStyle(.page(backgroundDisplayMode: .always))
                .frame(height: 250)
                .background(.background)
            }
        }
        .onChange(of: selected) { _, id in
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
        let from: CLLocationCoordinate2D
        let to: CLLocationCoordinate2D
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
            return Line(id: item.id, from: from, to: to, mode: item.transportMode, timed: item.isTimed)
        }
    }
}
