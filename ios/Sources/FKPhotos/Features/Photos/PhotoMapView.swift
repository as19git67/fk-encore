import MapKit
import SwiftUI

/// A map over a photo collection, with the trip's stops as a strip below it.
///
/// The web's `TripMap` counterpart (#1016). The grouping rules live in
/// `PhotoStops`, shared with the web via the same constants; this view draws
/// them and owns the selection.
///
/// Two things follow the web's design closely enough to be worth naming:
///
/// **The zoom drives the clustering.** What counts as one stop is whatever
/// would fit under one pin at the current zoom, so zooming in splits stops and
/// zooming out merges them, with the strip below following exactly — pins and
/// cards stay 1:1 because they read one clustering pass.
///
/// **The selection is a photo, not a stop.** Re-clustering renumbers every
/// stop, so an id held across a zoom would point at something else. The
/// selection anchors on a photo id and the stop is re-resolved from it, as the
/// web does with `selectedAnchorPhotoId`.
struct PhotoMapView: View {
    /// Shown as the navigation title — an album's name, usually.
    let title: String

    private let photos: [PhotoWithCuration]

    /// What one pin stands for — a stop, or a whole region in overview mode.
    struct Pin: Identifiable {
        let id: Int
        let coordinate: PhotoStops.Coordinate
        let label: String
        let photos: [PhotoWithCuration]
        let coverPhoto: PhotoWithCuration
    }

    /// The overview entry, or the stop a photo is in.
    enum Selection: Equatable {
        case overview
        case stop(anchorPhotoId: Int)
    }

    /// Everything one clustering pass yields. Held together because they are
    /// computed together: the overview merge is quadratic in the number of
    /// stops and the strip sorts the days, so reading them as computed
    /// properties would redo that work on every render — for a pan, a tap, a
    /// scroll. They change only when the radius does.
    private struct Clustered {
        var stops: [PhotoStops.Stop] = []
        var entries: [PhotoStops.TimelineEntry] = []
        var overviewPins: [Pin] = []
        var jumps: [PhotoStops.Jump] = []

        init() {}

        init(stops: [PhotoStops.Stop]) {
            self.stops = stops
            self.entries = PhotoStops.timeline(for: stops)
            self.jumps = PhotoStops.longJumps(for: stops)
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
    }

    @State private var clustered = Clustered()
    @State private var clusterRadius: Double?
    @State private var selection: Selection = .overview
    @State private var position: MapCameraPosition = .automatic
    @State private var openedPin: Pin?
    @State private var openedIndex = 0

    init(photos: [PhotoWithCuration], title: String) {
        self.photos = photos
        self.title = title
    }

    // MARK: - Derived

    /// The stop the selection points at, re-resolved from its anchor photo.
    private var selectedStop: PhotoStops.Stop? {
        guard case .stop(let anchorPhotoId) = selection else { return nil }
        return PhotoStops.stop(containing: anchorPhotoId, in: clustered.stops)
    }

    /// Overview: one pin per region. A stop: that stop's whole day, so the
    /// neighbours it sits between stay on the map.
    private var pins: [Pin] {
        guard let selectedStop else { return clustered.overviewPins }
        return clustered.stops.filter { $0.day == selectedStop.day }.map { stop in
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
        selection == .overview ? clustered.jumps : []
    }

    // MARK: - Body

    var body: some View {
        Group {
            if clustered.stops.isEmpty {
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
        // The first clustering uses the day-span heuristic; the map replaces
        // it with its own radius as soon as it has a view to measure.
        .onAppear {
            if clustered.stops.isEmpty {
                clustered = Clustered(stops: PhotoStops.stops(for: photos))
            }
        }
        .navigationTitle(title)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        // A pin opens straight into the fullscreen viewer over its own photos,
        // so paging stays inside the place that was tapped.
        //
        // The NavigationStack is not decoration: the viewer's only way out is
        // a toolbar chevron, and it deliberately disables the interactive pop
        // gesture. Presented bare in a cover it has no navigation bar to draw
        // that chevron in, and no swipe either — the photo is a dead end.
        .fullScreenCover(item: $openedPin) { pin in
            NavigationStack {
                PhotoFullscreenView(photos: pin.photos, currentIndex: $openedIndex)
            }
        }
    }

    // MARK: - Map

    private var map: some View {
        GeometryReader { geo in
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
            // Only when the gesture settles — the web re-clusters on `zoomend`
            // for the same reason, and a pass per frame would be far too much.
            .onMapCameraChange(frequency: .onEnd) { context in
                recluster(for: context.region, width: geo.size.width)
            }
            .onAppear { frameSelection() }
            .onChange(of: selection) { _, _ in
                withAnimation { frameSelection() }
            }
        }
    }

    /// Re-cluster for what the map now shows, if the radius moved enough to
    /// change anything. A pan keeps the zoom, so it must not cost a pass.
    private func recluster(for region: MKCoordinateRegion, width: CGFloat) {
        guard let radius = PhotoStops.clusterRadius(
            longitudeDelta: region.span.longitudeDelta,
            latitude: region.center.latitude,
            widthInPoints: Double(width)
        ) else { return }

        // A 2 % move cannot split or merge anything a reader would notice, and
        // MapKit reports slightly different spans for the same zoom after a pan.
        if let current = clusterRadius, abs(radius - current) / current < 0.02 { return }

        clusterRadius = radius
        clustered = Clustered(stops: PhotoStops.stops(for: photos, clusterRadiusMeters: radius))
        // The selection survives as its anchor photo; if that photo is gone
        // from the collection entirely, fall back to the overview rather than
        // pointing at nothing.
        if case .stop(let anchorPhotoId) = selection,
           PhotoStops.stop(containing: anchorPhotoId, in: clustered.stops) == nil {
            selection = .overview
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
        guard let bounds = PhotoStops.bounds(for: clustered.stops) else {
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
                    ForEach(clustered.entries) { entry in
                        card(for: entry).id(entry.id)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
            }
            .background(.bar)
            .onChange(of: selection) { _, _ in
                // Follow a selection made on the map; a tap on a card is
                // already where the reader is looking.
                withAnimation {
                    proxy.scrollTo(selectedStop?.id ?? PhotoStops.overviewEntryId, anchor: .center)
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
                isSelected: selectedStop?.id == stop.id,
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
                // Anchor on the stop's cover photo: the id would be renumbered
                // by the next re-cluster, the photo would not.
                selection = .stop(anchorPhotoId: stop.coverPhoto.id)
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
