import MapKit
import SwiftUI

/// Every way in the list, on one map (§4.7).
///
/// A list answers "what is there"; a map answers "where, and which of
/// these are the same walk twice". Forty rows of names cannot show
/// that three of them follow the same valley and the fourth is the
/// only one that leaves it — the shapes can, at a glance.
///
/// ## Tapped through a pin, not the line
///
/// SwiftUI's `Map` draws a `MapPolyline` but will not let anybody tap
/// one; only `Annotation` takes a gesture. So each way gets a pin at
/// its start, and that is the tap target — the same division the day
/// map already uses, where the line belongs to a pin rather than the
/// other way round.
///
/// A relation with no course at all still gets its pin, because where
/// it begins is the one thing known about it and a way that vanished
/// from the map would be worse than one drawn as a dot.
///
/// ## Colour says kind, so no legend is needed
///
/// Walking green, cycling blue. Two colours for four kinds, because
/// the difference that matters on a map is what you would be doing —
/// `hiking` against `foot` is a question for the row, not for the
/// shape.
struct TripRoutesMapView: View {
    let planId: Int
    let legIndex: Int
    let routes: [TripNearbyRoute]

    @State private var selected: TripNearbyRoute?

    var body: some View {
        Map(initialPosition: .region(region)) {
            ForEach(drawable) { route in
                if route.hasCourse, let via = route.via {
                    MapPolyline(coordinates: via.map(\.clCoordinate))
                        .stroke(colour(of: route),
                                style: StrokeStyle(lineWidth: 3,
                                                   lineCap: .round,
                                                   lineJoin: .round))
                }
                if let start = route.mapPoints.first {
                    Annotation(route.name, coordinate: start.clCoordinate) {
                        Button {
                            selected = route
                        } label: {
                            Image(systemName: route.symbolName)
                                .font(.caption2)
                                .padding(5)
                                .background(.background, in: .circle)
                                .overlay(Circle().stroke(colour(of: route), lineWidth: 2))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(route.name), \(route.summary)")
                    }
                    .annotationTitles(.hidden)
                }
            }
        }
        .navigationTitle("Strecken auf der Karte")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $selected) { route in
            NavigationStack {
                TripRouteCourseView(planId: planId, legIndex: legIndex, route: route)
            }
            .presentationDetents([.medium, .large])
        }
        .overlay(alignment: .bottom) {
            // What the colours mean and how much is drawn. Always
            // shown rather than behind a button: two colours and one
            // number do not cost enough screen to hide.
            Text("\(drawable.count) Strecken · grün zu Fuß, blau mit dem Rad")
                .font(.caption)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.thinMaterial, in: Capsule())
                .padding(.bottom, 12)
        }
    }

    /// The ways that have somewhere to be drawn. One without a course
    /// *and* without a start cannot appear at all — that is an answer
    /// from a backend older than §4.7's course, and it is left out
    /// rather than dropped at (0, 0) in the Atlantic.
    private var drawable: [TripNearbyRoute] {
        routes.filter { !$0.mapPoints.isEmpty }
    }

    private func colour(of route: TripNearbyRoute) -> Color {
        route.route == "bicycle" || route.route == "mtb" ? .blue : .green
    }

    /// Everything on screen at once, with a little air around it.
    ///
    /// Built from every point of every course rather than from the
    /// pins: a way whose start is in view and whose far end is forty
    /// kilometres away would otherwise run off the edge, which is
    /// exactly the thing this map exists to show.
    private var region: MKCoordinateRegion {
        let points = drawable.flatMap(\.mapPoints)
        guard let first = points.first else {
            return MKCoordinateRegion(
                center: CLLocationCoordinate2D(latitude: 0, longitude: 0),
                span: MKCoordinateSpan(latitudeDelta: 1, longitudeDelta: 1),
            )
        }
        var minLat = first.lat, maxLat = first.lat
        var minLon = first.lon, maxLon = first.lon
        for point in points {
            minLat = min(minLat, point.lat)
            maxLat = max(maxLat, point.lat)
            minLon = min(minLon, point.lon)
            maxLon = max(maxLon, point.lon)
        }
        return MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: (minLat + maxLat) / 2,
                                           longitude: (minLon + maxLon) / 2),
            span: MKCoordinateSpan(latitudeDelta: max((maxLat - minLat) * 1.2, 0.02),
                                   longitudeDelta: max((maxLon - minLon) * 1.2, 0.02)),
        )
    }
}
