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
    /// Which day of the plan the fences are for — what a sighting at
    /// the quarters is remembered under.
    private var dayIndex: Int?

    /// Photos the trip collected, for signal 2. Supplied by the caller
    /// rather than read here: which photos belong to the trip is Trip
    /// Mode's question, already answered, and asking it twice would be
    /// two versions of one rule.
    var recentPhotos: () -> [TripPhotoSignal.Photo] = { [] }

    /// The `osmRef` of the stop currently open — a fence was entered
    /// and has not been exited — or nil between stops. The honest
    /// answer to "where are we", for `TripDayActivityManager` (#768 §1)
    /// to prefer over the plan's own clock arithmetic: a museum visit
    /// does not end the moment its budget runs out, and a stop is not
    /// "reached" just because the clock says it should be by now.
    private(set) var openStopOsmRef: String?

    /// The plan the fences are for, when there are any — what a wake
    /// with no screen behind it falls back on to find the running day.
    var watchedPlanId: Int? { planId }

    private override init() {
        super.init()
        // Whatever the last run knew about its fences. iOS keeps the
        // fences across a relaunch and wakes a terminated app for them;
        // without this the app would wake knowing nothing — no plan, no
        // stop behind the fence, no arrival time for a stay — and drop
        // the visit on the floor. Out of the first trial: a whole day
        // with no stop ticked off.
        if let state = TripVisitMonitorState.load() {
            planId = state.planId
            dayIndex = state.dayIndex
            regions = Dictionary(state.regions.map { ($0.identifier, $0) }, uniquingKeysWith: { first, _ in first })
            stopIds = state.stopIds
            tracker = TripDwellTracker(openStays: state.openStays)
            openStopOsmRef = state.openStopOsmRef
        }
        // Set last, and in `init`: CoreLocation hands a relaunched app
        // the event that woke it as soon as a delegate exists, and that
        // delegate must already know the state above.
        manager.delegate = self
    }

    /// Called from the app delegate at launch, before anything else
    /// (§7.1). Creating the monitor is the point: iOS delivers the
    /// fence crossing that relaunched the app only to a location
    /// manager that exists by then, and nothing else creates this one
    /// until the day screen appears — which, in a pocket, it never does.
    static func resume() {
        _ = shared
    }

    /// Write what the monitor knows, so the next launch knows it too.
    private func persist() {
        TripVisitMonitorState(
            planId: planId,
            dayIndex: dayIndex,
            regions: Array(regions.values),
            stopIds: stopIds,
            openStays: tracker.openStays,
            openStopOsmRef: openStopOsmRef,
        ).save()
    }

    /// Start watching the stops of the day on screen.
    ///
    /// Idempotent, and safe to call whenever the plan changes: the
    /// fences are recomputed and any that are no longer wanted are
    /// dropped. Open stays for a dropped fence are closed rather than
    /// forgotten — standing in a museum when the plan changes is still
    /// a visit.
    ///
    /// `quarters` is the fence around the anchor (§4.2): crossed on
    /// arrival, which on the first day of a leg is the moment the day
    /// can be replanned from where the group actually is (§5).
    func watch(
        planId: Int,
        dayIndex: Int,
        stops: [TripStop],
        stopIdsByRef: [String: Int],
        quarters: TripMonitoredRegion? = nil,
    ) {
        guard CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else { return }
        let wanted = TripGeofencePlan.regions(for: stops) + (quarters.map { [$0] } ?? [])
        let wantedIds = Set(wanted.map(\.identifier))

        // What the fences meant before this call: a stay at a fence
        // that is being dropped is reported against it, not against the
        // new set that no longer knows it.
        let previousRegions = regions
        let previousStopIds = stopIds
        let previousPlanId = self.planId
        for (identifier, region) in previousRegions where !wantedIds.contains(identifier) {
            stopMonitoring(region)
            if let stay = tracker.exited(identifier, at: Date()) {
                if openStopOsmRef == identifier { openStopOsmRef = nil }
                Task { await report(stay, regions: previousRegions, stopIds: previousStopIds, planId: previousPlanId) }
            }
        }

        for region in wanted where regions[region.identifier] != region {
            if let previous = regions[region.identifier] { stopMonitoring(previous) }
            startMonitoring(region)
        }
        regions = Dictionary(wanted.map { ($0.identifier, $0) }, uniquingKeysWith: { first, _ in first })
        self.planId = planId
        self.dayIndex = dayIndex
        self.stopIds = stopIdsByRef
        persist()

        // "Always" is what lets iOS deliver a crossing to an app that is
        // not running. Without it the fences still exist but only fire
        // while the app is up, which is exactly when they are least
        // needed.
        if manager.authorizationStatus == .notDetermined {
            manager.requestAlwaysAuthorization()
        }
        manager.startMonitoringSignificantLocationChanges()
        // Whether the phone is already inside a fence — an app opened
        // at the hotel gets no entry event for a fence it is standing
        // in, and the arrival day needs to know.
        for region in manager.monitoredRegions where wantedIds.contains(region.identifier) {
            manager.requestState(for: region)
        }

        // Watching again is a moment with the app up and, usually, a
        // network — the right moment to send what could not be sent
        // from the tunnel.
        Task { await flushQueuedReports() }
    }

    /// Watch the day being lived — from a wake, not from a screen.
    ///
    /// The fences belong to today, whatever day is on screen: someone
    /// looking at tomorrow over breakfast has not left today's stops.
    /// And a new day moves them without anyone opening the plan: the
    /// first wake of the morning (a significant move, a foreground)
    /// lands here.
    ///
    /// Does nothing when the fences are already this day's. That is not
    /// only thrift: `watch` asks iOS whether the phone is inside each
    /// fence, the answer is itself a wake, and a wake comes back here —
    /// re-watching every time would never stop.
    func follow(_ running: TripRunningDay) {
        let stops = running.day.blocks.flatMap(\.stops)
        let quarters = TripGeofencePlan.anchorRegion(
            legId: running.leg.id, anchor: running.leg.anchor, radiusM: running.leg.anchorRadiusM)
        let wantedIds = Set(TripGeofencePlan.regions(for: stops).map(\.identifier) + [quarters.identifier])
        if planId == running.plan.id, dayIndex == running.day.dayIndex, Set(regions.keys) == wantedIds {
            return
        }
        watch(
            planId: running.plan.id,
            dayIndex: running.day.dayIndex,
            stops: stops,
            stopIdsByRef: Dictionary(stops.map { ($0.osmRef, $0.rowId) }, uniquingKeysWith: { first, _ in first }),
            quarters: quarters,
        )
    }

    /// Stop watching, closing anything still open.
    func stop() {
        for region in regions.values { stopMonitoring(region) }
        let closing = tracker.closeAll(at: Date())
        openStopOsmRef = nil
        manager.stopMonitoringSignificantLocationChanges()
        // Reported before the plan is forgotten: `report` needs to know
        // which plan and which fence a stay belongs to.
        let regionsAtStop = regions
        let stopIdsAtStop = stopIds
        let planIdAtStop = planId
        regions.removeAll()
        stopIds.removeAll()
        planId = nil
        dayIndex = nil
        TripVisitMonitorState.clear()
        for stay in closing {
            Task {
                await report(stay, regions: regionsAtStop, stopIds: stopIdsAtStop, planId: planIdAtStop)
            }
        }
    }

    /// Is this the quarters' fence rather than a stop's?
    private func isQuarters(_ identifier: String) -> Bool {
        regions[identifier]?.kind == .quarters
    }

    /// The phone is at the quarters: remembered for the arrival day's
    /// question, and the day is woken to ask it.
    private func sawQuarters() {
        guard let planId, let dayIndex else { return }
        TripDayNotices.shared.noteAtQuarters(planId: planId, dayIndex: dayIndex)
    }

    /// Whatever woke the app also moved the day on: the Live Activity
    /// and the offers are re-read from the same wake (§7.1). This is
    /// the only update either gets while the app is not in front.
    private func pulse(_ reason: TripDayNotices.Wake) {
        Task { await TripDayPulse.tick(reason) }
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
        await report(stay, regions: regions, stopIds: stopIds, planId: planId)
    }

    /// The same, against the fences as they were when the stay ended —
    /// `stop()` and `watch` forget or replace them straight after.
    private func report(
        _ stay: TripStay,
        regions: [String: TripMonitoredRegion],
        stopIds: [String: Int],
        planId: Int?,
    ) async {
        guard let planId, let region = regions[stay.regionId], region.kind == .stop else { return }
        guard TripDwellRule.isWorthReporting(stay, plannedMinutes: region.plannedMinutes) else {
            return
        }

        let formatter = ISO8601DateFormatter()
        let report = TripVisitReport(
            planId: planId,
            stopId: stopIds[stay.regionId],
            osmRef: region.osmRef,
            name: region.name,
            arrivedAt: formatter.string(from: stay.arrivedAt),
            leftAt: formatter.string(from: stay.departedAt),
            dwellMinutes: stay.minutes,
            hasMatchingPhoto: TripPhotoSignal.confirms(
                stay, region: region, photos: recentPhotos()),
            utcOffsetMinutes: TripInstant.utcOffsetMinutes(at: stay.arrivedAt),
        )
        // Whatever is still waiting goes first, so the diary keeps its
        // order; then this one. A failed report is not worth surfacing —
        // the stay is a by-product of walking around, and a network
        // error while doing so is not something the traveller can act
        // on — but it is worth **keeping**: a museum visited in the
        // tunnel is still a visit, and the queue is what the next
        // successful report or the next `watch` sends it from (§3.9).
        await flushQueuedReports()
        if !(await Self.send(report)) {
            TripVisitReportQueue.append(report)
        }
    }

    /// Send what earlier reports left behind, oldest first, stopping
    /// at the first one that fails again — the network is what it is.
    private func flushQueuedReports() async {
        for report in TripVisitReportQueue.load() {
            guard await Self.send(report) else { return }
            TripVisitReportQueue.remove(report)
        }
    }

    /// One report, one call. True when the server took it.
    ///
    /// And what it made of it is read, not thrown away: one signal is
    /// a question the traveller gets right now — "wart ihr hier?" —
    /// and two signals ticked the stop, which the day and the Lock
    /// Screen should show (§6.4). Until the first trial the verdict
    /// was decoded into nothing, and the question the server had
    /// written down was never asked.
    private static func send(_ report: TripVisitReport) async -> Bool {
        do {
            let response: TripVisitReportResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(report.planId)/visits", body: report.body)
            await MainActor.run {
                switch response.verdict {
                case "suggested":
                    if let visit = response.visit {
                        TripDayNotices.shared.offerVisit(visit, planId: report.planId)
                    }
                case "confirmed":
                    Task { await TripDayPulse.tick(.fenceExited) }
                default:
                    break
                }
            }
            return true
        } catch {
            return false
        }
    }

    // MARK: - CLLocationManagerDelegate
    //
    // `nonisolated` because CoreLocation calls these from its own
    // context; each hops onto the main actor immediately.

    nonisolated func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        let now = Date()
        Task { @MainActor in
            if isQuarters(region.identifier) {
                sawQuarters()
            } else {
                tracker.entered(region.identifier, at: now)
                openStopOsmRef = region.identifier
                persist()
            }
            pulse(.fenceEntered)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        let now = Date()
        Task { @MainActor in
            defer { pulse(.fenceExited) }
            guard !isQuarters(region.identifier) else { return }
            if openStopOsmRef == region.identifier { openStopOsmRef = nil }
            guard let stay = tracker.exited(region.identifier, at: now) else { return }
            persist()
            await report(stay)
        }
    }

    /// The significant-change service: a fix every few hundred metres
    /// of movement, delivered to an app that is not running. Started
    /// since the fences exist and, until the first trial, never read —
    /// so the one heartbeat the day had in the background went unused.
    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        Task { @MainActor in
            // A fix inside the quarters' fence counts as being there:
            // region entry is not delivered when the phone was inside
            // before the fence was set.
            if let quarters = regions.values.first(where: { $0.kind == .quarters }),
               location.distance(from: CLLocation(latitude: quarters.center.latitude,
                                                  longitude: quarters.center.longitude)) <= quarters.radius {
                sawQuarters()
            }
            pulse(.location)
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
        Task { @MainActor in
            if isQuarters(region.identifier) {
                sawQuarters()
            } else {
                tracker.entered(region.identifier, at: now)
                openStopOsmRef = region.identifier
                persist()
            }
            pulse(.fenceEntered)
        }
    }
}

/// One stay, ready to be told to the server (§7.1).
///
/// Kept whole — plan and all — because it may wait on disk until there
/// is a network, and by then the monitor may be watching another day.
/// The wire body is the same shape `visits.ts` has always taken; the
/// plan id only says which URL it goes to.
/// The app delegate's handle on the visit monitor, which is internal
/// to this module (§7.1). See `TripVisitMonitor.resume()`.
public enum TripLocationLaunch {
    @MainActor
    public static func resume() {
        TripVisitMonitor.resume()
    }
}

/// What the visit monitor knows, kept across launches (§7.1).
///
/// iOS keeps a fence after the app is terminated and relaunches the app
/// in the background when it is crossed — often hours later, after the
/// system reclaimed the memory. Everything the monitor held then is
/// gone unless it was written down: which plan, which stop is behind
/// which fence, and when the group walked into a place they have not
/// yet left. The last one is what a stay is measured from.
struct TripVisitMonitorState: Codable {
    var planId: Int?
    var dayIndex: Int?
    var regions: [TripMonitoredRegion]
    var stopIds: [String: Int]
    var openStays: [String: Date]
    var openStopOsmRef: String?

    static let key = "trip.visitMonitor.state"

    static func load(from store: UserDefaults = .standard) -> TripVisitMonitorState? {
        guard let data = store.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(TripVisitMonitorState.self, from: data)
    }

    func save(to store: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        store.set(data, forKey: Self.key)
    }

    static func clear(from store: UserDefaults = .standard) {
        store.removeObject(forKey: key)
    }
}

struct TripVisitReport: Codable, Equatable, Sendable {
    let planId: Int
    let stopId: Int?
    let osmRef: String
    let name: String?
    let arrivedAt: String
    let leftAt: String
    let dwellMinutes: Int
    let hasMatchingPhoto: Bool
    /// Which block the visit happened in depends on the clock at the
    /// place (§8.5). Optional so a report queued by an older build
    /// still decodes — it is then ticked, not moved.
    var utcOffsetMinutes: Int? = nil

    /// What goes over the wire — everything but the plan id, which is
    /// in the path.
    struct Body: Encodable {
        let stopId: Int?
        let osmRef: String
        let name: String?
        let arrivedAt: String
        let leftAt: String
        let dwellMinutes: Int
        let hasMatchingPhoto: Bool
        let utcOffsetMinutes: Int?
    }

    var body: Body {
        Body(
            stopId: stopId, osmRef: osmRef, name: name, arrivedAt: arrivedAt,
            leftAt: leftAt, dwellMinutes: dwellMinutes, hasMatchingPhoto: hasMatchingPhoto,
            utcOffsetMinutes: utcOffsetMinutes,
        )
    }
}

/// Reports that could not be sent, waiting for a network (§3.9).
///
/// A small array in the defaults, oldest first. Small on purpose: a
/// day has a dozen stays at most, and a queue that grew past a hundred
/// would mean a week offline — at which point the oldest are the ones
/// least worth keeping, so they are the ones dropped.
enum TripVisitReportQueue {
    static let key = "trip.visits.pending"
    static let capacity = 100

    static func load(from store: UserDefaults = .standard) -> [TripVisitReport] {
        guard let data = store.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([TripVisitReport].self, from: data)) ?? []
    }

    static func append(_ report: TripVisitReport, to store: UserDefaults = .standard) {
        var queue = load(from: store)
        queue.append(report)
        if queue.count > capacity { queue.removeFirst(queue.count - capacity) }
        save(queue, to: store)
    }

    static func remove(_ report: TripVisitReport, from store: UserDefaults = .standard) {
        save(load(from: store).filter { $0 != report }, to: store)
    }

    private static func save(_ queue: [TripVisitReport], to store: UserDefaults) {
        if queue.isEmpty {
            store.removeObject(forKey: key)
        } else if let data = try? JSONEncoder().encode(queue) {
            store.set(data, forKey: key)
        }
    }
}
