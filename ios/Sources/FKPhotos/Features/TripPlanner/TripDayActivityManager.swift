import ActivityKit
import Foundation

/// Keeps a Live Activity in step with the day a running trip is on
/// (#768 §1).
///
/// Two inputs feed one Activity: `TripRunningPlan` says *which* plan is
/// running today (already polled for the tab bar and the trip tab's own
/// banner — asking a third time would be a third version of the same
/// question), and a fetch of that plan's bundle supplies the actual day
/// — blocks, stops, light. `TripVisitMonitor.openStopOsmRef` corrects
/// the plan's clock-math guess with what a geofence actually confirmed.
///
/// Everything the Activity shows is computed locally, the same way the
/// day screen's own time slider is (§8.3). Out of the first trial,
/// that alone left "Mittag bis 14:00" on the Lock Screen at dinner: a
/// phone lying still gets no wake to recompute it. So the Activity is
/// also requested with a push token, which goes to the server
/// (`live-activity.ts`); the server computes the same content and
/// pushes it at each block boundary while the app sleeps.
@MainActor
final class TripDayActivityManager {
    static let shared = TripDayActivityManager()

    private var activity: Activity<TripDayActivityAttributes>?
    /// Which plan/day the running Activity is for, so a day change ends
    /// it and starts a fresh one instead of updating the wrong content
    /// under the old attributes.
    private var activePlanId: Int?
    /// The Activity's current push token, hex, once iOS handed one out.
    private var pushToken: String?
    private var tokenTask: Task<Void, Never>?

    private init() {}

    /// Call on app foreground and on a repeating timer while foregrounded
    /// (ActivityKit itself throttles updates to roughly once a minute, so
    /// calling this more often costs nothing extra), and from every
    /// background wake the visit monitor gets — a fence, a significant
    /// move. Those wakes are the only updates the Activity sees while
    /// the app is not in front, so each one counts.
    func refresh() async {
        await refresh(await TripRunningDay.load())
    }

    /// The same, from a day already loaded (`TripDayPulse`).
    func refresh(_ running: TripRunningDay?) async {
        guard let running else {
            await end()
            return
        }
        let planId = running.plan.id
        let day = running.day
        let now = Date()

        let confirmedName = TripVisitMonitor.shared.openStopOsmRef.flatMap { osmRef in
            day.blocks.flatMap(\.stops).first { $0.osmRef == osmRef }?.displayName
        }
        guard let content = TripDayActivityContent.build(
            day: day, at: TripDayTimeline.minutesOfDay(now), confirmedStopName: confirmedName, lightHint: running.light
        ) else {
            // Before the first block or after the last: nothing to show
            // for a day that has not started, or is already over.
            await end()
            return
        }
        // Stale at the block's end: what the Lock Screen shows after
        // that is marked as old rather than passed off as current.
        let staleDate = TripDayActivityContent.staleDate(blockEndMinutes: content.blockEndMinutes, now: now)

        // After a relaunch the Activity from the last run is still on
        // the Lock Screen and this process does not know it. Adopt it:
        // a new one cannot be started from the background, so without
        // this a woken app could neither update nor replace it.
        if activity == nil,
           let existing = Activity<TripDayActivityAttributes>.activities.first(where: { $0.attributes.planId == planId }) {
            activity = existing
            activePlanId = planId
            pushToken = existing.pushToken.map { $0.map { String(format: "%02x", $0) }.joined() }
            watchPushToken(of: existing, planId: planId)
        }

        if let activity, activePlanId == planId {
            await activity.update(.init(state: content, staleDate: staleDate))
            return
        }

        await end()
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let attributes = TripDayActivityAttributes(planId: planId, dayTitle: running.leg.anchorTitle)
        let initial = ActivityContent(state: content, staleDate: staleDate)
        // With a push token, so the server can keep it current while the
        // phone sleeps. Without one if iOS refuses that (push not set up
        // on this build): a local Activity is still better than none.
        activity = (try? Activity.request(attributes: attributes, content: initial, pushType: .token))
            ?? (try? Activity.request(attributes: attributes, content: initial))
        activePlanId = activity != nil ? planId : nil
        if let activity { watchPushToken(of: activity, planId: planId) }
    }

    /// iOS hands the token out asynchronously and may rotate it; each
    /// one goes to the server, which answers the same token with an
    /// upsert.
    private func watchPushToken(of activity: Activity<TripDayActivityAttributes>, planId: Int) {
        tokenTask?.cancel()
        tokenTask = Task { [weak self] in
            for await data in activity.pushTokenUpdates {
                let token = data.map { String(format: "%02x", $0) }.joined()
                self?.pushToken = token
                await Self.register(token: token, planId: planId)
            }
        }
    }

    private static func register(token: String, planId: Int) async {
        struct Body: Encodable {
            let token: String
            let environment: String
            let timeZone: String
        }
        struct Registered: Decodable { let registered: Bool }
        // A failure is not worth surfacing: the Activity still works
        // locally, and the next token or the next start tries again.
        _ = try? await APIClient.shared.post(
            "/trip-planner/plans/\(planId)/live-activity",
            body: Body(token: token, environment: RemotePushManager.environment,
                       timeZone: TimeZone.current.identifier)
        ) as Registered
    }

    /// Ends whatever Activity is running, if any. Called when the trip
    /// this Activity was for stops running today, and from the places
    /// that end a trip outright (`TripStore.endTrip()`, the auto-end
    /// suggestion being accepted).
    func end() async {
        // An Activity from an earlier run of the app is ended too: this
        // process may never have held it, and it would otherwise stay
        // on the Lock Screen until iOS gives up on it.
        guard let activity else {
            for leftover in Activity<TripDayActivityAttributes>.activities {
                await leftover.end(nil, dismissalPolicy: .immediate)
            }
            return
        }
        tokenTask?.cancel()
        tokenTask = nil
        if let token = pushToken, let planId = activePlanId {
            // The server stops pushing to an Activity that is gone.
            struct Body: Encodable { let token: String }
            struct Removed: Decodable { let removed: Bool }
            _ = try? await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/live-activity/end", body: Body(token: token)
            ) as Removed
        }
        pushToken = nil
        await activity.end(nil, dismissalPolicy: .immediate)
        self.activity = nil
        activePlanId = nil
    }
}
