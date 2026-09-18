import MapKit
import SwiftUI

/// One dot on a trip map (§5.2).
///
/// Deliberately not a stop and not a candidate: the map draws places,
/// and the two screens that use it disagree about everything else. A
/// day numbers its pins in walking order and colours them by status; a
/// pool has no order and colours by what kind of find it is. Both fit
/// in "a coordinate, a name, and a badge that says which one this is".
struct TripSpotMapPin: Identifiable, Equatable {
    let id: String
    let coordinate: TripCoordinate
    let title: String
    /// Its place in a walking order, where there is one (§8.3). The
    /// pool has none — a pool is not a route.
    var number: Int? = nil
    /// What to draw when there is no number. Nil leaves a plain dot.
    var symbolName: String? = nil
    let tint: Color
    /// Drawn larger: the day's slider marks where the plan says you
    /// would be at that hour.
    var emphasised: Bool = false
    /// Where the spot finishes when it is a route (§4.7): the map draws
    /// the way from the dot to here, and the day goes on from here.
    var extentEnd: TripCoordinate? = nil
}

/// The map both trip maps are made of: the base, the pins, the tap.
///
/// Pulled out of `TripDayMapView` when the pool wanted the same three
/// things (§5.2). It stays a pure function of its inputs — it is handed
/// pins and hands back the one that was tapped, and knows nothing about
/// plans, pools or what tapping is good for.
struct TripSpotMapView: View {
    /// Where the day (or the pool's leg) starts and ends — drawn with
    /// its own symbol, because it is not a stop.
    let anchor: TripCoordinate
    var anchorTitle: String = "Unterkunft"
    /// A house for the quarters; a day out is not a house (§4.5).
    var anchorSymbol: String = "house.fill"
    let pins: [TripSpotMapPin]
    /// True when the trip is running: then the blue dot is an answer to
    /// "where am I in all this" rather than a dot in another country.
    var showsUserLocation: Bool = false
    let onSelect: (TripSpotMapPin) -> Void

    @State private var camera: MapCameraPosition = .automatic

    var body: some View {
        Map(position: $camera) {
            if showsUserLocation {
                UserAnnotation()
            }
            // The anchor is where the day starts and ends. Shown with
            // its own symbol rather than a number: it is not a stop.
            Annotation(anchorTitle, coordinate: anchor.clCoordinate) {
                Image(systemName: anchorSymbol)
                    .padding(6)
                    .background(.background, in: .circle)
                    .overlay(Circle().stroke(.secondary))
            }

            // A route is a line, not a dot (§4.7). As the crow flies —
            // the app has no router and says so by drawing it dashed.
            ForEach(pins.filter { $0.extentEnd != nil }) { pin in
                if let end = pin.extentEnd {
                    MapPolyline(coordinates: [pin.coordinate.clCoordinate, end.clCoordinate])
                        .stroke(pin.tint, style: StrokeStyle(lineWidth: 3, dash: [6, 4]))
                    Annotation("Ende: \(pin.title)", coordinate: end.clCoordinate) {
                        Image(systemName: "flag.checkered")
                            .font(.caption2)
                            .padding(4)
                            .background(.background, in: .circle)
                            .overlay(Circle().stroke(pin.tint))
                    }
                    .annotationTitles(.hidden)
                }
            }

            ForEach(pins) { pin in
                Annotation(pin.title, coordinate: pin.coordinate.clCoordinate) {
                    Button {
                        onSelect(pin)
                    } label: {
                        badge(pin)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(spokenLabel(pin))
                }
            }
        }
        .mapStyle(.standard)
    }

    @ViewBuilder
    private func badge(_ pin: TripSpotMapPin) -> some View {
        let size: CGFloat = pin.emphasised ? 32 : 26
        Group {
            if let number = pin.number {
                Text("\(number)")
                    .font(.caption.weight(.bold))
            } else if let symbolName = pin.symbolName {
                Image(systemName: symbolName)
                    .font(.caption.weight(.semibold))
            } else {
                Color.clear
            }
        }
        .foregroundStyle(.white)
        .frame(width: size, height: size)
        .background(pin.tint, in: .circle)
        .overlay(Circle().stroke(.white, lineWidth: pin.emphasised ? 3 : 2))
        .animation(.easeInOut(duration: 0.15), value: pin.emphasised)
    }

    private func spokenLabel(_ pin: TripSpotMapPin) -> String {
        guard let number = pin.number else { return pin.title }
        return "\(number). \(pin.title)"
    }
}

extension TripCoordinate {
    var clCoordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: lat, longitude: lon)
    }
}
