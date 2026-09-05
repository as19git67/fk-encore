import CoreLocation
import Foundation

/// Noticing that a stop is done, without watching where you are
/// (§6.4, §7.1).
///
/// Region monitoring around the next one or two stops, plus the
/// significant-change service. iOS wakes the app when a fence is
/// crossed and costs practically nothing in between; the alternative —
/// continuous GPS — is the thing §7.1 rules out by name.
///
/// **What leaves the device is the event, never the track.** "X war an
/// Y von 13:40 bis 14:20" goes to the server; a table of coordinates
/// over time does not, because that would be a different product than
/// a travel diary (§7.1). The geofences themselves exist only in
/// CoreLocation, and the positions they are built from came from the
/// plan in the first place.
///
/// Everything decidable lives elsewhere and is tested there:
/// `TripGeofencePlan` picks the fences, `TripDwellTracker` turns
/// crossings into stays, `TripDwellRule` says which stays are worth
/// reporting, `TripPhotoSignal` says whether a photo backs one up. What
/// is left here is the CoreLocation plumbing and one network call —
/// deliberately, because none of it can be tested in CI.
@MainActor
final class TripVisitMonitor: NSObject, CLLocationManagerDelegate {
    static let shared = TripVisitMonitor()

    private let manager = CLLocationManager()
    private var tracker = TripDwellTracker()
    /// The fences currently set, by their identifier.
    private var regions: [String: TripMonitoredRegion] = [:]
    /// Which plan and stop each fence belongs to, so a report can name
    /// the stop rather than only a coordinate.
    private var stopIds: [String: Int] = [:]
    private var planId: Int?

    /// Photos the trip collected, for signal 2. Supplied by the caller
    /// rather than read here: which photos belong to the trip is Trip
    /// Mode's question, already answered, and asking it twice would be
    /// two versions of one rule.
    var recentPhotos: () -> [TripPhotoSignal.Photo] = { [] }

    private override init() {
        super.init()
        manager.delegate = self
    }

    /// Start watching the stops of the day on screen.
    ///
    /// Idempotent, and safe to call whenever the plan changes: the
    /// fences are recomputed and any that are no longer wanted are
    /// dropped. Open stays for a dropped fence are closed rather than
    /// forgotten — standing in a museum when the plan changes is still
    /// a visit.
    func watch(planId: Int, stops: [TripStop], stopIdsByRef: [String: Int]) {
        guard CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else { return }
        self.planId = planId
        self.stopIds = stopIdsByRef

        let wanted = TripGeofencePlan.regions(for: stops)
        let wantedIds = Set(wanted.map(\.identifier))

        for (identifier, region) in regions where !wantedIds.contains(identifier) {
            stopMonitoring(region)
            if let stay = tracker.exited(identifier, at: Date()) {
                Task { await report(stay) }
            }
        }

        for region in wanted where regions[region.identifier] != region {
            if let previous = regions[region.identifier] { stopMonitoring(previous) }
            startMonitoring(region)
        }
        regions = Dictionary(uniqueKeysWithValues: wanted.map { ($0.identifier, $0) })

        // "Always" is what lets iOS deliver a crossing to an app that is
        // not running. Without it the fences still exist but only fire
        // while the app is up, which is exactly when they are least
        // needed.
        if manager.authorizationStatus == .notDetermined {
            manager.requestAlwaysAuthorization()
        }
        manager.startMonitoringSignificantLocationChanges()
    }

    /// Stop watching, closing anything still open.
    func stop() {
        for region in regions.values { stopMonitoring(region) }
        let closing = tracker.closeAll(at: Date())
        regions.removeAll()
        stopIds.removeAll()
        manager.stopMonitoringSignificantLocationChanges()
        for stay in closing {
            Task { await report(stay) }
        }
        planId = nil
    }

    private func startMonitoring(_ region: TripMonitoredRegion) {
        let circular = CLCircularRegion(
            center: region.center,
            radius: region.radius,
            identifier: region.identifier,
        )
        circular.notifyOnEntry = true
        circular.notifyOnExit = true
        manager.startMonitoring(for: circular)
    }

    private func stopMonitoring(_ region: TripMonitoredRegion) {
        let monitored = manager.monitoredRegions.first { $0.identifier == region.identifier }
        if let monitored { manager.stopMonitoring(for: monitored) }
    }

    /// Tell the server about one stay, if it is long enough to mean
    /// anything.
    ///
    /// The threshold is checked here only to decide whether a network
    /// call is worth making. **The verdict is the server's** — it
    /// recomputes it from the same evidence, because the rule is a
    /// product decision and one that lives in two places drifts
    /// (`visits.ts`).
    private func report(_ stay: TripStay) async {
        guard let planId, let region = regions[stay.regionId] else { return }
        guard TripDwellRule.isWorthReporting(stay, plannedMinutes: region.plannedMinutes) else {
            return
        }

        struct Body: Encodable {
            let stopId: Int?
            let osmRef: String
            let name: String?
            let arrivedAt: String
            let leftAt: String
            let dwellMinutes: Int
            let hasMatchingPhoto: Bool
        }
        let formatter = ISO8601DateFormatter()
        let body = Body(
            stopId: stopIds[stay.regionId],
            osmRef: region.osmRef,
            name: region.name,
            arrivedAt: formatter.string(from: stay.arrivedAt),
            leftAt: formatter.string(from: stay.departedAt),
            dwellMinutes: stay.minutes,
            hasMatchingPhoto: TripPhotoSignal.confirms(
                stay, region: region, photos: recentPhotos()),
        )
        struct Ignored: Decodable {}
        // A failed report is not worth surfacing: the stay is a
        // by-product of walking around, and a network error while doing
        // so is not something the traveller can act on. The next sync of
        // the day's visits will show what was recorded.
        _ = try? await APIClient.shared.post(
            "/trip-planner/plans/\(planId)/visits", body: body) as Ignored
    }

    // MARK: - CLLocationManagerDelegate
    //
    // `nonisolated` because CoreLocation calls these from its own
    // context; each hops onto the main actor immediately.

    nonisolated func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        let now = Date()
        Task { @MainActor in tracker.entered(region.identifier, at: now) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        let now = Date()
        Task { @MainActor in
            guard let stay = tracker.exited(region.identifier, at: now) else { return }
            await report(stay)
        }
    }

    nonisolated func locationManager(
        _ manager: CLLocationManager,
        didDetermineState state: CLRegionState,
        for region: CLRegion,
    ) {
        // Asked for on launch, so an app that started up inside a fence
        // learns it is there. The tracker ignores a second entry for a
        // region already open, so this cannot restart a running clock.
        guard state == .inside else { return }
        let now = Date()
        Task { @MainActor in tracker.entered(region.identifier, at: now) }
    }
}
