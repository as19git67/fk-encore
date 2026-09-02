import MapKit
import SwiftUI

/// A map over a photo collection, with the trip's stops as a strip below it.
///
/// The web's `TripMap` counterpart (#1016, stages A and B). The grouping rules
/// live in `PhotoStops`, shared with the web via the same constants; this view
/// draws them and owns the selection.
///
/// One source of truth, as on the web: `selection`. The overview entry shows
/// the whole trip — one pin per region, the biggest hops between them. Picking
/// a stop shows *that stop's day*, so the neighbours stay visible, centres the
/// map on it and highlights both its pin and its card.
///
/// Not here yet: pins that re-split as the map zooms in (#1016 stage C).
struct PhotoMapView: View {
    /// Shown as the navigation title — an album's name, usually.
    let title: String

    /// What one pin stands for — a stop, or a whole region in overview mode.
    struct Pin: Identifiable {
        let id: Int
        let coordinate: PhotoStops.Coordinate
        let label: String
        let photos: [PhotoWithCuration]
        let coverPhoto: PhotoWithCuration
    }

    /// The overview entry, or one stop.
    enum Selection: Equatable {
        case overview
        case stop(id: Int)
    }

    /// Clustered once, in `init`. Both clustering passes are quadratic in the
    /// number of stops and `body` reads the results several times over, so
    /// computing them per render would redo that work on every pan and zoom —
    /// neither of which changes the grouping.
    private let stops: [PhotoStops.Stop]
    private let stopsById: [Int: PhotoStops.Stop]
    private let stopsByDay: [String: [PhotoStops.Stop]]
    private let entries: [PhotoStops.TimelineEntry]
    private let overviewPins: [Pin]
    private let tripJumps: [PhotoStops.Jump]

    @State private var selection: Selection = .overview
    @State private var position: MapCameraPosition = .automatic
    @State private var openedPin: Pin?
    @State private var openedIndex = 0

    init(photos: [PhotoWithCuration], title: String) {
        let stops = PhotoStops.stops(for: photos)
        self.title = title
        self.stops = stops
        self.stopsById = Dictionary(stops.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        self.stopsByDay = PhotoStops.byDay(stops)
        self.entries = PhotoStops.timeline(for: stops)
        self.tripJumps = PhotoStops.longJumps(for: stops)
        self.overviewPins = PhotoStops.overviewClusters(for: stops).map { cluster in
            Pin(
                id: cluster.id,
                coordinate: cluster.coordinate,
                label: PhotoStops.locationLabel(for: cluster.coverPhoto),
                photos: cluster.photos,
                coverPhoto: cluster.coverPhoto
            )
        }
    }

    /// The stop the selection points at, if any.
    private var selectedStop: PhotoStops.Stop? {
        guard case .stop(let id) = selection else { return nil }
        return stopsById[id]
    }

    /// Overview: one pin per region. A stop: that stop's whole day, so the
    /// neighbours it sits between stay on the map.
    private var pins: [Pin] {
        guard let selectedStop else { return overviewPins }
        return (stopsByDay[selectedStop.day] ?? []).map { stop in
            Pin(
                id: stop.id,
                coordinate: stop.coordinate,
                label: PhotoStops.title(of: stop),
                photos: stop.photos,
                coverPhoto: stop.coverPhoto
            )
        }
    }

    /// Hops belong to the trip as a whole. Within one day every move is a
    /// short hop, so the 90th-percentile rule would just pick an arbitrary one.
    private var jumps: [PhotoStops.Jump] {
        selection == .overview ? tripJumps : []
    }

    var body: some View {
        Group {
            if stops.isEmpty {
                ContentUnavailableView {
                    Label("Keine Orte", systemImage: "mappin.slash")
                } description: {
                    Text("Keines dieser Fotos hat Koordinaten.")
                }
            } else {
                VStack(spacing: 0) {
                    map
                    timeline
                }
            }
        }
        .navigationTitle(title)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        // A pin opens straight into the fullscreen viewer over its own photos,
        // so paging stays inside the place that was tapped.
        .fullScreenCover(item: $openedPin) { pin in
            PhotoFullscreenView(photos: pin.photos, currentIndex: $openedIndex)
        }
    }

    // MARK: - Map

    private var map: some View {
        Map(position: $position) {
            ForEach(jumps.indices, id: \.self) { index in
                let jump = jumps[index]
                MapPolyline(coordinates: [
                    CLLocationCoordinate2D(latitude: jump.from.latitude, longitude: jump.from.longitude),
                    CLLocationCoordinate2D(latitude: jump.to.latitude, longitude: jump.to.longitude),
                ])
                .stroke(.secondary, style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
            }
            ForEach(pins) { pin in
                Annotation(
                    pin.label,
                    coordinate: CLLocationCoordinate2D(
                        latitude: pin.coordinate.latitude,
                        longitude: pin.coordinate.longitude
                    )
                ) {
                    PhotoStopPin(
                        cover: pin.coverPhoto,
                        count: pin.photos.count,
                        isSelected: selectedStop?.id == pin.id
                    ) {
                        openedIndex = 0
                        openedPin = pin
                    }
                }
            }
        }
        .onAppear { frameSelection() }
        .onChange(of: selection) { _, _ in
            withAnimation { frameSelection() }
        }
    }

    /// Frame whatever the selection points at: the whole trip, or one stop
    /// close up. Falls back to `.automatic` when there is nothing to fit,
    /// which lets MapKit pick.
    private func frameSelection() {
        if let selectedStop {
            position = .region(MKCoordinateRegion(
                center: CLLocationCoordinate2D(
                    latitude: selectedStop.coordinate.latitude,
                    longitude: selectedStop.coordinate.longitude
                ),
                span: MKCoordinateSpan(latitudeDelta: 0.01, longitudeDelta: 0.01)
            ))
            return
        }
        guard let bounds = PhotoStops.bounds(for: overviewPins.map(\.coordinate)) else {
            position = .automatic
            return
        }
        position = .region(MKCoordinateRegion(
            center: CLLocationCoordinate2D(
                latitude: (bounds.minLatitude + bounds.maxLatitude) / 2,
                longitude: (bounds.minLongitude + bounds.maxLongitude) / 2
            ),
            span: MKCoordinateSpan(
                latitudeDelta: max(bounds.maxLatitude - bounds.minLatitude, 0.005),
                longitudeDelta: max(bounds.maxLongitude - bounds.minLongitude, 0.005)
            )
        ))
    }

    // MARK: - Timeline

    /// Every stop across every day as one continuous chronological run, led by
    /// the overview card — the web's strip. Tapping a card moves the map;
    /// opening the photos is the pin's job, so a scroll past a card never
    /// throws the viewer open.
    private var timeline: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(entries) { entry in
                        card(for: entry).id(entry.id)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
            }
            .background(.bar)
            .onChange(of: selection) { _, new in
                // Follow a selection made on the map; a tap on a card is
                // already where the reader is looking.
                withAnimation {
                    switch new {
                    case .overview: proxy.scrollTo(-1, anchor: .center)
                    case .stop(let id): proxy.scrollTo(id, anchor: .center)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func card(for entry: PhotoStops.TimelineEntry) -> some View {
        switch entry {
        case .overview(let dayCount):
            TimelineCard(
                isSelected: selection == .overview,
                accent: nil,
                title: "Übersicht",
                subtitle: "\(dayCount) \(dayCount == 1 ? "Tag" : "Tage")",
                detail: nil,
                thumbnail: nil
            ) {
                selection = .overview
            }
        case .stop(let stop, let isFirstOfDay, let color):
            TimelineCard(
                isSelected: selection == .stop(id: stop.id),
                // Only the first stop of a day carries the day's colour, which
                // is what makes the day boundaries readable in a long run.
                accent: isFirstOfDay ? PhotoStops.rgb(fromHex: color).map {
                    Color(red: $0.red, green: $0.green, blue: $0.blue)
                } : nil,
                title: PhotoStops.title(of: stop),
                subtitle: PhotoMapView.stopDate(of: stop),
                detail: "\(stop.photos.count) \(stop.photos.count == 1 ? "Foto" : "Fotos")",
                thumbnail: stop.coverPhoto
            ) {
                selection = .stop(id: stop.id)
            }
        }
    }

    // MARK: - Labels

    /// A stop's date, short, as the web writes it („05. Mär").
    static func stopDate(
        of stop: PhotoStops.Stop,
        locale: Locale = Locale(identifier: "de_DE"),
        timeZone: TimeZone = .current
    ) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = timeZone
        formatter.dateFormat = "dd. MMM"
        return formatter.string(from: PhotoStops.takenAt(stop.coverPhoto))
    }
}

/// One card in the timeline strip.
private struct TimelineCard: View {
    let isSelected: Bool
    /// The day's colour, on the first stop of each day only.
    let accent: Color?
    let title: String
    let subtitle: String
    let detail: String?
    /// Nil on the overview card, which shows a globe instead.
    let thumbnail: PhotoWithCuration?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let accent {
                    Capsule()
                        .fill(accent)
                        .frame(width: 3, height: 34)
                }
                if let thumbnail {
                    PhotoThumbnailView(filename: thumbnail.filename, autoCrop: thumbnail.auto_crop)
                        .frame(width: 34, height: 34)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                } else {
                    Image(systemName: "globe.europe.africa")
                        .font(.title3)
                        .frame(width: 34, height: 34)
                        .foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.caption.bold())
                        .lineLimit(1)
                    Text(subtitle)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    if let detail {
                        Text(detail)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: 130, alignment: .leading)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(
                isSelected
                    ? AnyShapeStyle(Color.accentColor.opacity(0.25))
                    : AnyShapeStyle(.quaternary),
                in: RoundedRectangle(cornerRadius: 10)
            )
        }
        .buttonStyle(.plain)
    }
}

/// A pin: its cover photo, with the number of photos behind it.
private struct PhotoStopPin: View {
    let cover: PhotoWithCuration
    let count: Int
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            PhotoThumbnailView(filename: cover.filename, autoCrop: cover.auto_crop)
                .frame(width: isSelected ? 56 : 44, height: isSelected ? 56 : 44)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay {
                    RoundedRectangle(cornerRadius: 8)
                        .strokeBorder(
                            isSelected ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.background),
                            lineWidth: 2
                        )
                }
                .overlay(alignment: .bottomTrailing) {
                    if count > 1 {
                        Text("\(count)")
                            .font(.caption2.bold())
                            .foregroundStyle(.white)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(.black.opacity(0.7), in: Capsule())
                            .offset(x: 3, y: 3)
                    }
                }
                .shadow(radius: 3)
        }
        .buttonStyle(.plain)
    }
}
