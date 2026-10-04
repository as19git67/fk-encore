import MapKit
import SwiftUI

/// The small map at the top of a spot (§25, stage B).
///
/// It used to be a picture: a static map that took no touch, with the
/// way into a maps app three sections further down. Now it zooms in
/// place — the one thing somebody wanting to see where exactly the
/// place is will try first — and carries a small button that opens the
/// maps app chosen in the settings. Zoom only, no pan: the snippet
/// sits in a list, and a map that takes the drag is a list that no
/// longer scrolls.
struct TripSpotMapSnippet: View {
    let coordinate: TripCoordinate
    /// What the marker says.
    let title: String
    /// What the maps app is told; nil for a place without a name.
    let name: String?
    let symbolName: String
    var height: CGFloat = 180

    @AppStorage(TripMapsPreference.key) private var mapsPreference: String = TripMapsApp.apple.rawValue
    @State private var position: MapCameraPosition

    init(coordinate: TripCoordinate, title: String, name: String?, symbolName: String, height: CGFloat = 180) {
        self.coordinate = coordinate
        self.title = title
        self.name = name
        self.symbolName = symbolName
        self.height = height
        _position = State(initialValue: .region(MKCoordinateRegion(
            center: CLLocationCoordinate2D(coordinate),
            latitudinalMeters: 600, longitudinalMeters: 600,
        )))
    }

    var body: some View {
        Map(position: $position, interactionModes: [.zoom]) {
            Marker(title, systemImage: symbolName, coordinate: CLLocationCoordinate2D(coordinate))
        }
        .frame(height: height)
        .overlay(alignment: .bottomTrailing) {
            Button {
                TripMapsOpen.pin(coordinate, name: name, using: preference)
            } label: {
                Image(systemName: "arrow.up.right.square")
                    .font(.body.weight(.semibold))
                    .frame(width: 44, height: 44)
                    .background(.regularMaterial, in: .circle)
                    .contentShape(.circle)
            }
            .buttonStyle(.plain)
            .padding(8)
            .accessibilityLabel("In der Karten-App öffnen")
        }
    }

    private var preference: TripMapsApp {
        TripMapsApp(rawValue: mapsPreference) ?? .apple
    }
}
