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
    /// Optional **exclusion** zone around the user's home: a photo taken inside
    /// it is not a trip photo, everything else in the window is. `nil` means
    /// pure time-window membership.
    ///
    /// This replaces the start-anchored *inclusion* geofence of Etappe 1b-ii,
    /// which broke the moment a trip actually travelled: it only ever admitted
    /// photos within 25 km of wherever Trip Mode happened to be switched on, so
    /// a trip started in München silently dropped everything shot in Frankfurt.
    /// The documented intent was always „daheim während laufendem Trip gemachte
    /// Fotos fallen raus" (§5) — which is what an exclusion zone around *home*
    /// expresses, independent of where the trip starts or goes.
    var homeExclusion: Geofence?
    /// High-water mark on `creationDate`: the auto-add pass has examined every
    /// asset in the window up to this instant, so the next pass only needs to
    /// enumerate from here (`docs/ios-trip-mode.md` §14.4). `nil` before the
    /// first pass — then the window starts at `startedAt`.
    ///
    /// Missing from trips persisted before the watermark existed; the synthesised
    /// decoder maps that to `nil`, so the next pass simply starts at `startedAt`
    /// once and compacts the state from there.
    var handledWatermark: Date?
    /// The assets examined at exactly `handledWatermark` — the small edge list
    /// that keeps the inclusive `creationDate >= watermark` enumeration exact.
    /// A burst can share one timestamp, so a strict `>` bound would silently
    /// drop its remaining shots; instead the boundary is re-enumerated and these
    /// IDs are skipped.
    ///
    /// Everything *below* the watermark is covered by the watermark itself, so
    /// this list stays burst-sized instead of growing with the trip. It is also
    /// what keeps an aussortiertes Foto out: once handled, an asset is either
    /// below the watermark (never enumerated again) or listed here (skipped).
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

    /// Radius of the home exclusion zone. Matches
    /// `TripAutoEndPreferences.homeArrivalRadiusMeters` — the same notion of
    /// „zuhause" decides both „end the trip?" and „this isn't a trip photo".
    /// Deliberately tight: a trip is defined by its time window, and the only
    /// thing the zone has to catch is the quick shot taken at home while a trip
    /// is nominally still running.
    static let homeExclusionRadiusMeters: CLLocationDistance =
        TripAutoEndPreferences.homeArrivalRadiusMeters

    /// Whether an asset belongs to the trip: taken inside the capture window
    /// `[startedAt, endedAt]` (open-ended while the trip runs) and not inside
    /// the home exclusion zone, when one is set.
    ///
    /// The window is the rule; the zone only carves out home. A trip travels —
    /// distance from where it started says nothing about whether a photo
    /// belongs to it, which is exactly what the old start-anchored geofence got
    /// wrong (see `ActiveTrip.homeExclusion`).
    ///
    /// An asset without a creation date can't be placed in the window and is
    /// excluded. An asset without GPS **is** included — im Zweifel aufnehmen
    /// (`docs/ios-trip-mode.md` §14.4).
    static func includes(creationDate: Date?, location: CLLocation?, trip: ActiveTrip) -> Bool {
        guard let creationDate else { return false }
        guard creationDate >= trip.startedAt else { return false }
        if let endedAt = trip.endedAt, creationDate > endedAt { return false }
        guard let home = trip.homeExclusion, let location else { return true }
        let center = CLLocation(latitude: home.latitude, longitude: home.longitude)
        return location.distance(from: center) > home.radiusMeters
    }

    /// Records that a pass examined the whole window up to `watermark`.
    ///
    /// `edge` are the assets seen at exactly that timestamp. When the watermark
    /// moves forward they *replace* the old edge list — everything before is
    /// covered by the watermark itself, which is what keeps the persisted state
    /// small on a long trip. When the pass found nothing newer, the edge lists
    /// are merged, so an asset that appeared at the boundary after the previous
    /// pass isn't forgotten.
    ///
    /// A watermark older than the stored one is ignored: the pass enumerates
    /// from the stored watermark, so that can only be a stale result.
    static func advanced(_ trip: ActiveTrip, watermark: Date, edge: [String]) -> ActiveTrip {
        var updated = trip
        guard let current = trip.handledWatermark else {
            updated.handledWatermark = watermark
            updated.handledAssetIds = edge
            return updated
        }
        if watermark < current { return trip }

        if watermark == current {
            var seen = Set(trip.handledAssetIds)
            updated.handledAssetIds = trip.handledAssetIds + edge.filter { seen.insert($0).inserted }
        } else {
            updated.handledAssetIds = edge
        }
        updated.handledWatermark = watermark
        return updated
    }
}

/// UserDefaults persistence for the active trip and for ended trips that are
/// still within their catch-up grace period.
enum TripPreferences {
    private static let activeTripKey = "trip.active"
    private static let closedTripsKey = "trip.closed"

    static func loadActiveTrip() -> ActiveTrip? {
        guard let data = UserDefaults.standard.data(forKey: activeTripKey) else { return nil }
        return decodeActiveTrip(data)
    }

    /// Decodes a persisted active trip, applying the start-geofence migration.
    /// Split out from `loadActiveTrip()` so the migration is unit-testable
    /// without UserDefaults.
    static func decodeActiveTrip(_ data: Data) -> ActiveTrip? {
        guard let trip = try? JSONDecoder().decode(ActiveTrip.self, from: data) else { return nil }
        let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        return migratedFromStartGeofence(trip, raw: raw)
    }

    /// Repairs a trip that was persisted under the old start-anchored geofence.
    ///
    /// Two things have to happen for such a trip, and only for such a trip:
    ///
    /// 1. The geofence itself is dropped (the decoded `homeExclusion` is
    ///    already `nil` — the legacy key doesn't map onto it), so membership
    ///    falls back to the pure time window and the trip stops discarding
    ///    photos taken away from its start location.
    /// 2. The watermark is reset, because the old rule's damage is otherwise
    ///    permanent: the pass advances the watermark over assets it *examined*,
    ///    including the ones the geofence rejected (`docs/ios-trip-mode.md`
    ///    §14.4). Those photos sit below the watermark and would never be
    ///    enumerated again, so fixing the rule alone would not bring back the
    ///    photos the user already took.
    ///
    /// Re-enumerating from `startedAt` can re-add a photo the user had
    /// deliberately removed from the album, because the pruned `handledAssetIds`
    /// no longer names it. That is a one-off, bounded to trips that were
    /// actually subject to the broken rule, and the alternative is losing the
    /// trip's photos outright — the trade-off §4 does not have to make for
    /// anyone else, since trips without a legacy geofence are left untouched.
    static func migratedFromStartGeofence(_ trip: ActiveTrip, raw: [String: Any]?) -> ActiveTrip {
        guard let raw, raw["geofence"] is [String: Any] else { return trip }
        var migrated = trip
        migrated.handledWatermark = nil
        return migrated
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
        guard let data = UserDefaults.standard.data(forKey: closedTripsKey) else { return [] }
        return decodeClosedTrips(data)
    }

    /// Decodes the persisted ended trips, applying the same start-geofence
    /// migration as `decodeActiveTrip`. An ended trip is still inside its
    /// catch-up grace period, so repairing it can genuinely recover photos.
    static func decodeClosedTrips(_ data: Data) -> [ActiveTrip] {
        guard let trips = try? JSONDecoder().decode([ActiveTrip].self, from: data) else { return [] }
        let raw = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]]
        return trips.enumerated().map { index, trip in
            migratedFromStartGeofence(trip, raw: raw?.indices.contains(index) == true ? raw?[index] : nil)
        }
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
