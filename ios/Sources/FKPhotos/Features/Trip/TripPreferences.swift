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

/// UserDefaults persistence for the single active trip.
enum TripPreferences {
    private static let activeTripKey = "trip.active"

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
}
