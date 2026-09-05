import CoreLocation
import Foundation

/// Which stops to put a geofence around, and how big (§7.1, §6.4).
///
/// The concept is specific about the shape of this and about why: **no
/// continuous GPS**, but region monitoring around the next one or two
/// stops plus significant-location-change. iOS wakes the app when it
/// matters and costs practically nothing in between. Watching a whole
/// day of stops would be the same battery drain as continuous tracking,
/// arrived at by a different route.
///
/// The radius is by object size, not one number for everything. A
/// viewpoint is a spot you stand on; a park is a place you are inside
/// for three hundred metres in every direction. One radius for both
/// either misses the viewpoint or counts the walk past the park.
///
/// A pure type: what it decides can be tested without a location
/// manager, a simulator, or a walk around the block.
enum TripGeofencePlan {
    /// How many stops to watch at once.
    ///
    /// §7.1 says one or two. iOS allows twenty regions per app, but the
    /// point is not the ceiling — it is that a fence you are nowhere
    /// near is a wake-up that buys nothing. Two covers "the one we are
    /// heading for" and "the one after it, if we skip ahead".
    static let maximumRegions = 2

    /// Radius by category, in metres.
    ///
    /// Deliberately generous rather than tight. A fence smaller than
    /// the place misses the visit outright; one larger than the place
    /// costs a longer dwell before the threshold is met, which the
    /// dwell rule already handles. Erring outward fails softly.
    static func radius(for category: String) -> CLLocationDistance {
        switch category {
        case "viewpoint": return 60
        case "outdoors": return 300
        case "museum", "theatre", "worship": return 120
        case "sight": return 100
        case "food", "cafe", "essentials": return 60
        default:
            // Includes "unknown", the category a find with no OSM entry
            // carries (§9.2). A middling radius is the honest answer for
            // a place whose size nobody knows.
            return 100
        }
    }

    /// The stops to monitor, in the order they matter.
    ///
    /// Anything already settled is skipped — done *or* skipped. A fence
    /// around a place you have been is a wake-up with nothing behind it,
    /// and one around a place you deliberately dropped is worse: it
    /// would ask about a stop you already said no to.
    ///
    /// What remains is taken in plan order rather than by distance,
    /// because the plan is the prediction of where you are going. The
    /// nearest unvisited stop may be one you walked past on purpose.
    static func regions(for stops: [TripStop]) -> [TripMonitoredRegion] {
        stops
            .filter { $0.stopStatus == .planned }
            .prefix(maximumRegions)
            .map { stop in
                TripMonitoredRegion(
                    osmRef: stop.osmRef,
                    name: stop.name,
                    center: CLLocationCoordinate2D(latitude: stop.lat, longitude: stop.lon),
                    radius: radius(for: stop.category),
                    plannedMinutes: stop.dwellMinutes,
                )
            }
    }
}

/// One fence, and what the visit rule needs to know about the place
/// behind it.
struct TripMonitoredRegion: Equatable, Sendable {
    let osmRef: String
    let name: String?
    let center: CLLocationCoordinate2D
    let radius: CLLocationDistance
    /// What the plan allowed for it. The dwell threshold is a quarter
    /// of this, floored at ten minutes (`visits.ts`).
    let plannedMinutes: Int

    /// The identifier the region is monitored under. The `osmRef` is
    /// already unique within a plan and is what the visit report is
    /// keyed by, so nothing has to be looked up on the way back.
    var identifier: String { osmRef }

    static func == (lhs: TripMonitoredRegion, rhs: TripMonitoredRegion) -> Bool {
        lhs.osmRef == rhs.osmRef
            && lhs.radius == rhs.radius
            && lhs.center.latitude == rhs.center.latitude
            && lhs.center.longitude == rhs.center.longitude
    }
}
