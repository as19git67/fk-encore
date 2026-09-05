import Foundation

/// Handing a stop, or a whole block, over to a map app (§9.1).
///
/// The URL building is pure and lives here so it can be tested without a
/// device: opening the wrong app with the wrong travel mode is not
/// something a screenshot catches, and the arrival time the whole plan
/// reckons with depends on it. A block planned on foot must not open as
/// a car route.
///
/// Three things the concept insists on, each of which is a decision
/// rather than a detail:
///
///   - **The destination app is the user's choice, not ours.** Plenty of
///     people navigate with Google Maps out of habit, especially abroad
///     where its transit data is often better.
///   - **Google Maps only appears when it is installed**, checked with
///     `canOpenURL` on `comgooglemaps://` — which needs an entry in
///     `LSApplicationQueriesSchemes`. Without it the check silently
///     answers "not installed" and the option vanishes for no visible
///     reason. Nothing at runtime can tell the two apart, so the
///     Info.plist entry is guarded by a test that reads the file
///     (`TripMapsHandoffTests`) rather than by code here.
///   - **A whole block goes over at once.** Apple's `openMaps` takes an
///     array of destinations and Google's URL knows waypoints, so the
///     morning travels as one route rather than one leg at a time.
enum TripMapsApp: String, CaseIterable, Sendable {
    case apple
    case google
    /// Ask each time. Only offered when there is something to choose.
    case ask

    var label: String {
        switch self {
        case .apple:  return "Apple Karten"
        case .google: return "Google Maps"
        case .ask:    return "Jedes Mal fragen"
        }
    }

    /// The scheme whose presence says Google Maps is installed.
    static let googleScheme = "comgooglemaps"
}

/// What a route is for. Named separately from `TripTransportMode`
/// because the two map apps spell it differently and neither spelling
/// belongs in the planner.
enum TripRouteMode: Sendable {
    case walking
    case transit
    case driving
    case cycling

    /// The planner's leg mode, translated. Cycling has no Apple
    /// equivalent, so it falls back rather than silently becoming a car
    /// route — see `appleDirectionsMode`.
    init(_ mode: TripTransportMode) {
        switch mode {
        case .foot:    self = .walking
        case .bike:    self = .cycling
        case .transit: self = .transit
        case .car:     self = .driving
        }
    }

    /// `MKLaunchOptionsDirectionsModeKey` values.
    ///
    /// Apple Maps has no cycling directions mode, and choosing driving
    /// for a cycling leg would hand back an arrival time the plan did
    /// not budget for. Walking is the honest fallback: too slow rather
    /// than too fast, so the block still holds.
    var appleDirectionsMode: String {
        switch self {
        case .walking, .cycling: return "MKLaunchOptionsDirectionsModeWalking"
        case .transit:           return "MKLaunchOptionsDirectionsModeTransit"
        case .driving:           return "MKLaunchOptionsDirectionsModeDriving"
        }
    }

    /// `directionsmode` in the `comgooglemaps://` URL.
    var googleDirectionsMode: String {
        switch self {
        case .walking: return "walking"
        case .cycling: return "bicycling"
        case .transit: return "transit"
        case .driving: return "driving"
        }
    }

    /// `travelmode` in the universal `https://www.google.com/maps/dir/` URL.
    var googleTravelMode: String { googleDirectionsMode }
}

/// The URLs. Pure, so the tests can read them.
enum TripMapsURL {

    /// Navigate to one place with the Google Maps app.
    static func googleApp(to destination: TripCoordinate, mode: TripRouteMode) -> URL? {
        var components = URLComponents()
        components.scheme = TripMapsApp.googleScheme
        components.host = ""
        components.path = "/"
        components.queryItems = [
            URLQueryItem(name: "daddr", value: coordinate(destination)),
            URLQueryItem(name: "directionsmode", value: mode.googleDirectionsMode),
        ]
        return components.url
    }

    /// The universal Google URL: opens the app when it is there, the
    /// browser otherwise. This is what makes the choice work even when
    /// the scheme check fails for want of an Info.plist entry (§9.1).
    ///
    /// Waypoints carry the whole block over at once; the last stop is
    /// the destination and everything before it a waypoint.
    static func googleUniversal(
        through stops: [TripCoordinate],
        from origin: TripCoordinate? = nil,
        mode: TripRouteMode,
    ) -> URL? {
        guard let destination = stops.last else { return nil }
        var components = URLComponents(string: "https://www.google.com/maps/dir/")
        var items = [
            URLQueryItem(name: "api", value: "1"),
            URLQueryItem(name: "destination", value: coordinate(destination)),
            URLQueryItem(name: "travelmode", value: mode.googleTravelMode),
        ]
        if let origin {
            items.insert(URLQueryItem(name: "origin", value: coordinate(origin)), at: 1)
        }
        let waypoints = stops.dropLast()
        if !waypoints.isEmpty {
            items.append(URLQueryItem(
                name: "waypoints",
                value: waypoints.map(coordinate).joined(separator: "|"),
            ))
        }
        components?.queryItems = items
        return components?.url
    }

    /// Look a place up rather than route to it — ratings, indoor
    /// photos, today's opening hours. The deliberate counterweight to
    /// what open data cannot give (§10).
    ///
    /// The name is a hint, not an identifier: the coordinate is what
    /// decides which place opens, so a wrong or missing name cannot send
    /// the traveller somewhere else.
    static func googleLookup(_ place: TripCoordinate, name: String?) -> URL? {
        var components = URLComponents(string: "https://www.google.com/maps/search/")
        // Google resolves a "name near coordinate" query to the place
        // itself; a bare coordinate lands on the point. Either way the
        // coordinate is present, so a wrong name cannot send the
        // traveller somewhere else — it only sharpens the match.
        let query = (name?.isEmpty == false)
            ? "\(name!) \(coordinate(place))"
            : coordinate(place)
        components?.queryItems = [
            URLQueryItem(name: "api", value: "1"),
            URLQueryItem(name: "query", value: query),
        ]
        return components?.url
    }

    /// Six decimals is about ten centimetres — far past what a POI
    /// coordinate is worth, and stable across locales, which `String`
    /// interpolation of a `Double` is not guaranteed to be.
    static func coordinate(_ c: TripCoordinate) -> String {
        String(format: "%.6f,%.6f", locale: Locale(identifier: "en_US_POSIX"), c.lat, c.lon)
    }
}

/// Which handoffs are available, given the setting and what is
/// installed. Separated from the URLs so the availability rule — the
/// part with the stumbling block in it — can be tested on its own.
struct TripMapsAvailability: Sendable {
    let preference: TripMapsApp
    let googleAppInstalled: Bool

    /// What to offer. Google appears only when it is actually there;
    /// "ask" collapses to a single option when there is nothing to ask
    /// about, because a chooser with one entry is a worse Apple Maps.
    var options: [TripMapsApp] {
        googleAppInstalled ? [.apple, .google] : [.apple]
    }

    /// The app to open without asking, or nil when the user should be
    /// asked. Never returns Google when it is not installed, whatever
    /// the stored preference says — an uninstalled app is a dead end,
    /// and the setting may predate its removal.
    var resolved: TripMapsApp? {
        switch preference {
        case .apple:  return .apple
        case .google: return googleAppInstalled ? .google : .apple
        case .ask:    return googleAppInstalled ? nil : .apple
        }
    }
}

/// The stored setting (§9.1). Apple Maps by default, because it is
/// always present.
enum TripMapsPreference {
    static let key = "tripPlanner.mapsApp"

    static func load(_ defaults: UserDefaults = .standard) -> TripMapsApp {
        guard let raw = defaults.string(forKey: key), let app = TripMapsApp(rawValue: raw) else {
            return .apple
        }
        return app
    }

    static func save(_ app: TripMapsApp, to defaults: UserDefaults = .standard) {
        defaults.set(app.rawValue, forKey: key)
    }
}
