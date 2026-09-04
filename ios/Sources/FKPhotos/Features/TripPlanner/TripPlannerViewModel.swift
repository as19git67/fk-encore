import SwiftUI

/// Loads one plan and holds what the day screen needs.
///
/// Deliberately thin. Every decision the concept cares about — what fits
/// in a block, what a fixpoint costs, which day is detailed — is made by
/// the server and arrives in the plan; this only fetches it, tracks
/// which leg and day are on screen, and offers the two actions that
/// change a plan from here: detailing a later day (§4.3) and asking for
/// a redistribution (§5).
///
/// That split matters beyond tidiness: the same arithmetic has to be
/// reproducible offline on the device later (§3.9), and it will only
/// stay reproducible if the app never accumulates its own version of it.
@Observable @MainActor
final class TripPlannerViewModel {
    private(set) var plan: TripPlan?
    private(set) var isLoading = false
    /// Set while a day is being detailed, so the button can say so.
    private(set) var isDetailing = false
    var errorMessage: String?

    /// Which leg and day are on screen. Both are positions within their
    /// parent, not row ids, because that is how the endpoints address
    /// them.
    var legIndex: Int = 0
    var dayIndex: Int = 0

    /// Spots whose "Warum hier?" is open (§8.3), keyed by `osmRef`.
    var expandedReasons: Set<String> = []

    private let planId: Int

    init(planId: Int) {
        self.planId = planId
    }

    var leg: TripLeg? {
        plan?.legs.first { $0.position == legIndex }
    }

    var day: TripDay? {
        leg?.days.first { $0.dayIndex == dayIndex }
    }

    /// Every stop of the current day, in order across blocks — what the
    /// map numbers its pins by.
    var stopsOfDay: [TripStop] {
        day?.blocks.flatMap(\.stops) ?? []
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response: TripPlanResponse =
                try await APIClient.shared.get("/trip-planner/plans/\(planId)")
            apply(response)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Bring the day on screen from trip resolution to day resolution
    /// (§4.3) — the thing you do the evening before.
    func detailCurrentDay() async {
        guard let day, !day.detailed else { return }
        isDetailing = true
        defer { isDetailing = false }
        struct Body: Encodable {
            let legIndex: Int
            let dayIndex: Int
        }
        do {
            let response: TripPlanResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/days/detail",
                body: Body(legIndex: legIndex, dayIndex: dayIndex),
            )
            apply(response)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Tick a spot off, or skip it (§8.5).
    ///
    /// A single write, not a replan: swiping a spot done is not a
    /// request to rearrange the afternoon. What it does do is set what a
    /// later redistribution reads as past.
    func mark(_ stop: TripStop, as status: TripStopStatus) async {
        guard let plan else { return }
        struct Body: Encodable {
            let stopId: Int
            let status: String
        }
        do {
            let response: TripPlanResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(plan.id)/stops/status",
                body: Body(stopId: stop.rowId, status: status.rawValue),
            )
            apply(response)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func toggleReasons(for osmRef: String) {
        if expandedReasons.contains(osmRef) {
            expandedReasons.remove(osmRef)
        } else {
            expandedReasons.insert(osmRef)
        }
    }

    /// Why a stop is in the plan. The scoring lives in the pool, so a
    /// stop's reasons are looked up by reference rather than carried on
    /// the stop itself — and an unexplained spot honestly has no line
    /// rather than a made-up one (§15.3).
    func reasons(for stop: TripStop) -> [String] {
        leg?.pool.first { $0.osmRef == stop.osmRef }?.reasons ?? []
    }

    private func apply(_ response: TripPlanResponse) {
        plan = response.plan
        // A plan can come back with fewer legs or days than the screen
        // was showing — clamp rather than leave the view pointing at
        // something that no longer exists.
        if let plan {
            legIndex = min(legIndex, max(0, plan.legs.count - 1))
            if let leg = plan.legs.first(where: { $0.position == legIndex }) {
                dayIndex = min(dayIndex, max(0, leg.days.count - 1))
            }
        }
        errorMessage = nil
    }
}
