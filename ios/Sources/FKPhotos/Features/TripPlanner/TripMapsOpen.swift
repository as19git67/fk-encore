import MapKit
import UIKit

/// Actually opening a map app (§9.1).
///
/// `TripMapsHandoff.swift` builds the URLs and stays pure so the
/// arithmetic can be tested without a device; this is the other half,
/// the three lines that touch `UIApplication` and `MKMapItem`. It exists
/// as its own type because the same handoff is now reached from three
/// screens — the day, the pool, and a spot's details — and three copies
/// of "which app, and does it want a route or a pin" is how one of them
/// ends up opening a car route for a walking leg.
@MainActor
enum TripMapsOpen {
    /// Is Google Maps actually installed?
    ///
    /// Needs `comgooglemaps` in `LSApplicationQueriesSchemes`; without
    /// it this silently answers "no" and the option vanishes for no
    /// visible reason, which is why the Info.plist entry has a test of
    /// its own rather than a comment.
    static var googleInstalled: Bool {
        UIApplication.shared.canOpenURL(URL(string: "\(TripMapsApp.googleScheme)://")!)
    }

    /// Show the place. No route, no travel time, no arrival estimate.
    ///
    /// At the kitchen table "where is that?" is the whole question, and
    /// a route from home to a café you will walk to next month is a
    /// number nobody wants.
    static func pin(_ place: TripCoordinate, name: String?, using app: TripMapsApp) {
        switch app {
        case .google:
            if let url = TripMapsURL.googleLookup(place, name: name) {
                UIApplication.shared.open(url)
                return
            }
            applePin(place, name: name)
        case .apple, .ask:
            // "Ask each time" is a question about *routing* — which app
            // should take you there. A pin is not that question, so it
            // goes to Apple Maps, which is always installed.
            applePin(place, name: name)
        }
    }

    /// Route there, in the app the traveller chose.
    static func route(_ choice: TripMapsChoice, using app: TripMapsApp) {
        switch app {
        case .apple:
            let items = choice.coordinates.map { coordinate in
                MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(
                    latitude: coordinate.lat, longitude: coordinate.lon)))
            }
            guard !items.isEmpty else { return }
            MKMapItem.openMaps(with: items, launchOptions: [
                MKLaunchOptionsDirectionsModeKey: choice.routeMode.appleDirectionsMode,
            ])
        case .google, .ask:
            // The universal URL rather than the scheme: it opens the app
            // when it is there and the browser otherwise, so the choice
            // still works if the scheme check failed for want of an
            // Info.plist entry (§9.1).
            guard let url = TripMapsURL.googleUniversal(
                through: choice.coordinates, mode: choice.routeMode) else { return }
            UIApplication.shared.open(url)
        }
    }

    private static func applePin(_ place: TripCoordinate, name: String?) {
        let item = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(
            latitude: place.lat, longitude: place.lon)))
        item.name = name
        // No directions mode: without one, Maps shows the place rather
        // than a route to it.
        item.openInMaps()
    }
}
