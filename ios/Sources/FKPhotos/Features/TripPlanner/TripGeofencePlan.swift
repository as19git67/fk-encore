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
    /// Every open stop of the day, up to what iOS allows: twenty
    /// regions per app, one of which is the quarters (§4.2). It used
    /// to be two — "the one we are heading for and the one after it" —
    /// on the reasoning that a fence you are nowhere near is a wake-up
    /// that buys nothing. The first trial showed the day that matters:
    /// the family strolled through the town without the plan, passed
    /// stop five, and nothing asked, because only stops one and two
    /// had a fence. Region monitoring costs the same for nineteen
    /// fences as for two — the radio wakes on cell changes either way
    /// — so the cap is the platform's, not the battery's.
    static let maximumRegions = 19

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

    /// The fence around the quarters (§4.2).
    ///
    /// Where every day begins and ends — and on the arrival day the one
    /// place that can say "we are here now", which the stops' fences
    /// cannot: a family whose plane landed five hours late reaches the
    /// hotel first and its stops never (§5). A zone anchor keeps its
    /// own radius; an address gets a generous hundred and fifty metres,
    /// because a hotel's fence is crossed on the way to the door.
    static let anchorRadius: CLLocationDistance = 150

    static func anchorRegion(legId: Int, anchor: TripCoordinate, radiusM: Int?) -> TripMonitoredRegion {
        TripMonitoredRegion(
            osmRef: "anchor:\(legId)",
            name: nil,
            center: CLLocationCoordinate2D(latitude: anchor.lat, longitude: anchor.lon),
            radius: max(anchorRadius, CLLocationDistance(radiusM ?? 0)),
            plannedMinutes: 0,
            kind: .quarters,
        )
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
    /// nearest unvisited stop may be one you walked past on purpose —
    /// which only matters on a day with more open stops than fences.
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
    /// A stop of the day, or the quarters. A stay at the quarters is
    /// not a visit and is never reported; being there at all is what
    /// the arrival day wants to know.
    enum Kind: Sendable { case stop, quarters }

    let osmRef: String
    let name: String?
    let center: CLLocationCoordinate2D
    let radius: CLLocationDistance
    /// What the plan allowed for it. The dwell threshold is a quarter
    /// of this, floored at ten minutes (`visits.ts`).
    let plannedMinutes: Int
    var kind: Kind = .stop

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
