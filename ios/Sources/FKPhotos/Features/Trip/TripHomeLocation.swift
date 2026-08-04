import CoreLocation
import Foundation

/// Resolves the user's home location — the server-side home centroid derived
/// from their geotagged photo history (`GET /trips/home-location`, which reuses
/// the recap centroid so client and server agree on where "home" is).
///
/// Two callers need it and must not disagree: `TripAutoEndMonitor` (is the
/// device back home, should we suggest ending the trip?) and `TripStore` (which
/// area does a running trip exclude from its photos?). Keeping the fetch and
/// its cache in one place means a trip's exclusion zone is centred on exactly
/// the spot that will later be recognised as "arrived home".
///
/// Best-effort throughout: a missing home location is not an error, it just
/// means the trip runs on its time window alone.
enum TripHomeLocation {
    /// Serialises concurrent fetches so two callers arriving together don't
    /// both hit the endpoint. Non-isolated state guarded by the main actor —
    /// every entry point below is `@MainActor`.
    @MainActor private static var isFetching = false

    /// The cached home location, refreshed from the server when missing or
    /// stale. Returns whatever is cached (possibly `nil`) if the fetch fails or
    /// another fetch is already in flight.
    @MainActor
    static func resolve() async -> CLLocationCoordinate2D? {
        if TripAutoEndPreferences.isHomeLocationFresh, let cached = TripAutoEndPreferences.homeLocation {
            return cached
        }
        guard !isFetching else { return TripAutoEndPreferences.homeLocation }
        isFetching = true
        defer { isFetching = false }

        struct Response: Decodable {
            struct Location: Decodable { let lat: Double; let lon: Double }
            let location: Location?
        }
        guard let response: Response = try? await APIClient.shared.get("/trips/home-location"),
              let location = response.location
        else {
            return TripAutoEndPreferences.homeLocation
        }
        let coordinate = CLLocationCoordinate2D(latitude: location.lat, longitude: location.lon)
        TripAutoEndPreferences.homeLocation = coordinate
        return coordinate
    }

    /// The exclusion zone to stamp onto a starting trip, or `nil` when no home
    /// location is known — then the trip is a pure time window, which is the
    /// documented default (`docs/ios-trip-mode.md` §2).
    @MainActor
    static func exclusionZone() async -> ActiveTrip.Geofence? {
        guard let home = await resolve() else { return nil }
        return ActiveTrip.Geofence(
            latitude: home.latitude,
            longitude: home.longitude,
            radiusMeters: TripMembership.homeExclusionRadiusMeters
        )
    }
}
