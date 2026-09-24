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
/// No server push: everything the Activity shows is computed locally,
/// the same way the day screen's own time slider is (§8.3), and a
/// finished plan is already downloadable whole for exactly this kind of
/// offline use (§3.9).
@MainActor
final class TripDayActivityManager {
    static let shared = TripDayActivityManager()

    private var activity: Activity<TripDayActivityAttributes>?
    /// Which plan/day the running Activity is for, so a day change ends
    /// it and starts a fresh one instead of updating the wrong content
    /// under the old attributes.
    private var activePlanId: Int?

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

        if let activity, activePlanId == planId {
            await activity.update(.init(state: content, staleDate: staleDate))
            return
        }

        await end()
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let attributes = TripDayActivityAttributes(planId: planId, dayTitle: running.leg.anchorTitle)
        activity = try? Activity.request(
            attributes: attributes,
            content: .init(state: content, staleDate: staleDate)
        )
        activePlanId = activity != nil ? planId : nil
    }

    /// Ends whatever Activity is running, if any. Called when the trip
    /// this Activity was for stops running today, and from the places
    /// that end a trip outright (`TripStore.endTrip()`, the auto-end
    /// suggestion being accepted).
    func end() async {
        guard let activity else { return }
        await activity.end(nil, dismissalPolicy: .immediate)
        self.activity = nil
        activePlanId = nil
    }
}
