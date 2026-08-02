import CoreLocation
import Foundation

/// Persistent model of the single active trip (Trip Mode).
///
/// Exactly one trip is active at a time (Etappe-1-Entscheidung). Toggling a
/// trip off does not delete anything — it just clears the active trip; the
/// underlying iOS album, server album and sync link stay in place and keep
/// syncing as a normal linked album.
struct ActiveTrip: Codable, Equatable, Sendable {
    /// Server album this trip syncs into.
    var serverAlbumId: Int
    /// `PHAssetCollection.localIdentifier` of the auto-created iOS album.
    var iosAlbumId: String
    var name: String
    var startedAt: Date
    /// End of the capture window. `nil` while the trip is running; set the
    /// moment the user ends it. The catch-up pass keeps running for an ended
    /// trip during its grace period (see `TripMembership`), but only ever adds
    /// photos taken **up to** this instant — everything shot afterwards is no
    /// longer a trip photo.
    var endedAt: Date?
    /// Auto: new photos are added automatically (Etappe 1c). Manual: they are
    /// only surfaced for review and added on demand.
    var autoAdd: Bool
    var mode: PhotoSyncMode
    /// Optional geofence that narrows trip membership. Captured in Etappe 1b-ii
    /// (CoreLocation); `nil` means pure time-window membership.
    var geofence: Geofence?
    /// Assets the auto-add pass has already handled (Etappe 1c). Kept so an
    /// aussortiertes Foto is never re-added. Empty until Etappe 1c.
    var handledAssetIds: [String]
    /// Assets explicitly dismissed in the manual review grid (Etappe 2).
    var dismissedAssetIds: [String]
    /// Shared trip (Etappe 3). `false` for a solo trip.
    var isShared: Bool
    /// Owner of a shared trip (Etappe 3); `nil` for a solo trip.
    var ownerUserId: Int?

    struct Geofence: Codable, Equatable, Sendable {
        var latitude: Double
        var longitude: Double
        var radiusMeters: Double
    }
}

/// Decides whether a photo belongs to a trip, and how long an ended trip still
/// needs to be looked at. Pure functions with no PhotoKit/UserDefaults access
/// so the membership contract is unit-testable (`TripMembershipTests`).
enum TripMembership {
    /// How long after `endedAt` the catch-up pass keeps processing an ended
    /// trip. The pass only runs when the app is alive, so photos taken shortly
    /// before the trip ended can still be waiting when the user ends it (and
    /// even a late import can land in the window afterwards). One day of
    /// nachlauf closes that gap without keeping stale trips around forever.
    static let closedTripGrace: TimeInterval = 24 * 60 * 60

    /// True once an ended trip has outlived its grace period and can be
    /// dropped from the pending list.
    static func isExpired(_ trip: ActiveTrip, now: Date) -> Bool {
        guard let endedAt = trip.endedAt else { return false }
        return now.timeIntervalSince(endedAt) > closedTripGrace
    }

    /// Whether an asset belongs to the trip: taken inside the capture window
    /// `[startedAt, endedAt]` (open-ended while the trip runs) and, when a
    /// geofence is set, within its radius.
    ///
    /// An asset without a creation date can't be placed in the window and is
    /// excluded. An asset without GPS **is** included even under a geofence —
    /// im Zweifel aufnehmen (`docs/ios-trip-mode.md` §14.4).
    static func includes(creationDate: Date?, location: CLLocation?, trip: ActiveTrip) -> Bool {
        guard let creationDate else { return false }
        guard creationDate >= trip.startedAt else { return false }
        if let endedAt = trip.endedAt, creationDate > endedAt { return false }
        guard let geofence = trip.geofence, let location else { return true }
        let center = CLLocation(latitude: geofence.latitude, longitude: geofence.longitude)
        return location.distance(from: center) <= geofence.radiusMeters
    }
}

/// UserDefaults persistence for the active trip and for ended trips that are
/// still within their catch-up grace period.
enum TripPreferences {
    private static let activeTripKey = "trip.active"
    private static let closedTripsKey = "trip.closed"

    static func loadActiveTrip() -> ActiveTrip? {
        guard let data = UserDefaults.standard.data(forKey: activeTripKey),
              let trip = try? JSONDecoder().decode(ActiveTrip.self, from: data) else {
            return nil
        }
        return trip
    }

    static func saveActiveTrip(_ trip: ActiveTrip?) {
        guard let trip else {
            UserDefaults.standard.removeObject(forKey: activeTripKey)
            return
        }
        if let data = try? JSONEncoder().encode(trip) {
            UserDefaults.standard.set(data, forKey: activeTripKey)
        }
    }

    /// Ended trips still awaiting their final catch-up pass. Kept separate from
    /// the active trip so ending a trip never loses the photos that were taken
    /// while the app was suspended.
    static func loadClosedTrips() -> [ActiveTrip] {
        guard let data = UserDefaults.standard.data(forKey: closedTripsKey),
              let trips = try? JSONDecoder().decode([ActiveTrip].self, from: data) else {
            return []
        }
        return trips
    }

    static func saveClosedTrips(_ trips: [ActiveTrip]) {
        guard !trips.isEmpty else {
            UserDefaults.standard.removeObject(forKey: closedTripsKey)
            return
        }
        if let data = try? JSONEncoder().encode(trips) {
            UserDefaults.standard.set(data, forKey: closedTripsKey)
        }
    }
}
