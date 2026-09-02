import MapKit
import SwiftUI

/// A map over a photo collection: one pin per place the photos were taken.
///
/// The web's `TripMap` counterpart, first stage (#1016). The grouping rules
/// live in `PhotoStops`, shared with the web via the same constants; this view
/// only draws them.
///
/// Two modes, as on the web. Without a day filter the map shows the whole
/// trip, so nearby stops from different days share one pin (the web's
/// „Ganze Reise" overview) and the trip's biggest hops are drawn between them.
/// Picking a day drops to that day's own stops.
///
/// Not here yet: the day/stop timeline beside the map, and pins that re-split
/// as the map zooms in.
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

    /// Clustered once, in `init`. Both clustering passes are quadratic in the
    /// number of stops and `body` reads the results several times over, so
    /// computing them per render would redo that work on every pan and zoom —
    /// neither of which changes the grouping.
    private let stopsByDay: [String: [Pin]]
    private let overviewPins: [Pin]
    private let days: [String]
    private let tripJumps: [PhotoStops.Jump]

    /// `nil` = the whole trip. Picking a day narrows the map to its stops.
    @State private var selectedDay: String?
    @State private var position: MapCameraPosition = .automatic
    @State private var openedPin: Pin?
    @State private var openedIndex = 0

    init(photos: [PhotoWithCuration], title: String) {
        let stops = PhotoStops.stops(for: photos)
        self.title = title
        self.days = PhotoStops.days(of: stops)
        self.tripJumps = PhotoStops.longJumps(for: stops)
        self.stopsByDay = PhotoStops.byDay(stops).mapValues { dayStops in
            dayStops.map { stop in
                Pin(
                    id: stop.id,
                    coordinate: stop.coordinate,
                    label: stop.locationLabel,
                    photos: stop.photos,
                    coverPhoto: stop.coverPhoto
                )
            }
        }
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

    private var pins: [Pin] {
        guard let selectedDay else { return overviewPins }
        return stopsByDay[selectedDay] ?? []
    }

    /// Hops belong to the trip as a whole. Within one day every move is a
    /// short hop, so the 90th-percentile rule would just pick an arbitrary one.
    private var jumps: [PhotoStops.Jump] {
        selectedDay == nil ? tripJumps : []
    }

    var body: some View {
        Group {
            if overviewPins.isEmpty {
                ContentUnavailableView {
                    Label("Keine Orte", systemImage: "mappin.slash")
                } description: {
                    Text("Keines dieser Fotos hat Koordinaten.")
                }
            } else {
                map
            }
        }
        .navigationTitle(title)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            if days.count > 1 {
                ToolbarItem(placement: .primaryAction) {
                    dayMenu
                }
            }
        }
        // A pin opens straight into the fullscreen viewer over its own photos,
        // so paging stays inside the place that was tapped.
        .fullScreenCover(item: $openedPin) { pin in
            PhotoFullscreenView(photos: pin.photos, currentIndex: $openedIndex)
        }
    }

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
                    PhotoStopPin(cover: pin.coverPhoto, count: pin.photos.count) {
                        openedIndex = 0
                        openedPin = pin
                    }
                }
            }
        }
        .onAppear { fitPins() }
        .onChange(of: selectedDay) { _, _ in fitPins() }
    }

    private var dayMenu: some View {
        Menu {
            Button {
                selectedDay = nil
            } label: {
                Label("Ganze Reise", systemImage: selectedDay == nil ? "checkmark" : "map")
            }
            ForEach(days, id: \.self) { day in
                Button {
                    selectedDay = day
                } label: {
                    Label(
                        PhotoMapView.dayLabel(day),
                        systemImage: selectedDay == day ? "checkmark" : "calendar"
                    )
                }
            }
        } label: {
            Label("Tag", systemImage: "calendar")
        }
    }

    /// Frame whatever is on the map right now. Falls back to `.automatic` when
    /// there is nothing to fit, which lets MapKit pick.
    private func fitPins() {
        guard let bounds = PhotoStops.bounds(for: pins.map(\.coordinate)) else {
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

    /// A day key (`YYYY-MM-DD`) as a reader would say it. The key is built from
    /// local components, so it is read back the same way.
    static func dayLabel(_ day: String, locale: Locale = Locale(identifier: "de_DE")) -> String {
        let parser = DateFormatter()
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.dateFormat = "yyyy-MM-dd"
        guard let date = parser.date(from: day) else { return day }
        let out = DateFormatter()
        out.locale = locale
        out.dateFormat = "d. MMMM yyyy"
        return out.string(from: date)
    }
}

/// A pin: its cover photo, with the number of photos behind it.
private struct PhotoStopPin: View {
    let cover: PhotoWithCuration
    let count: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            PhotoThumbnailView(filename: cover.filename, autoCrop: cover.auto_crop)
                .frame(width: 44, height: 44)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay {
                    RoundedRectangle(cornerRadius: 8)
                        .strokeBorder(.background, lineWidth: 2)
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
