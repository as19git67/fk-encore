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
    /// calling this more often costs nothing extra), and immediately after
    /// `TripVisitMonitor` confirms or clears a dwell.
    func refresh() async {
        guard let planId = TripRunningPlan.shared.plan?.id else {
            await end()
            return
        }

        guard let bundle = try? await Self.fetchBundle(planId: planId),
              let position = bundle.plan.position(on: Date()),
              let leg = bundle.plan.legs.first(where: { $0.position == position.legIndex }),
              let day = leg.days.first(where: { $0.dayIndex == position.dayIndex }),
              day.detailed
        else {
            await end()
            return
        }

        let confirmedName = TripVisitMonitor.shared.openStopOsmRef.flatMap { osmRef in
            day.blocks.flatMap(\.stops).first { $0.osmRef == osmRef }?.displayName
        }
        let light = bundle.lightOfDay(legIndex: position.legIndex, dayIndex: position.dayIndex)
        guard let content = TripDayActivityContent.build(
            day: day, at: TripDayTimeline.minutesOfDay(Date()), confirmedStopName: confirmedName, lightHint: light
        ) else {
            // Before the first block or after the last: nothing to show
            // for a day that has not started, or is already over.
            await end()
            return
        }

        if let activity, activePlanId == planId {
            await activity.update(.init(state: content, staleDate: nil))
            return
        }

        await end()
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let attributes = TripDayActivityAttributes(planId: planId, dayTitle: leg.anchorTitle)
        activity = try? Activity.request(
            attributes: attributes,
            content: .init(state: content, staleDate: nil)
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

    private static func fetchBundle(planId: Int) async throws -> TripOfflineBundle {
        try await APIClient.shared.get(
            "/trip-planner/plans/\(planId)/bundle",
            query: ["utcOffsetMinutes": String(TimeZone.current.secondsFromGMT() / 60)],
        )
    }
}
