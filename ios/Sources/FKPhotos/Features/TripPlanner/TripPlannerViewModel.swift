import CoreLocation
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
    /// Set while a redistribution is running (§5, §8.5).
    private(set) var isRedistributing = false
    /// What the last redistribution moved out — the sentence to show (§5).
    private(set) var displaced: [TripDisplacedStop] = []
    /// Blocks the last drag pushed over budget — the red ones (§8.4).
    private(set) var overfullBlockIds: Set<String> = []
    /// Why a redistribution could not run, in words the traveller can act on.
    var redistributeBlockedReason: String?
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

    /// "Umplanen" — the big button of §8.5.
    ///
    /// Everything it needs beyond the plan is *where* and *when*: the
    /// position comes from CoreLocation, and which block the group is
    /// in, plus how much of it is left, come from the day's own frame
    /// (§4.1). None of it is guessed — if the day carries no block
    /// times, or the clock is outside them, or there is no fix, the
    /// button says why instead of redistributing around a made-up
    /// position. A rearranged afternoon built on a guess is worse than
    /// no rearrangement.
    func redistributeNow(
        now: Date = Date(),
        locationProvider: TripLocationProvider = TripLocationProvider(
            accuracy: kCLLocationAccuracyNearestTenMeters,
        ),
    ) async {
        guard let plan, let day else { return }
        redistributeBlockedReason = nil

        let minutes = TripDayTimeline.minutesOfDay(now)
        guard let block = TripDayTimeline.block(in: day, at: minutes) else {
            redistributeBlockedReason = day.blocks.contains(where: { $0.startMinutes != nil })
                ? "Gerade läuft kein Block dieses Tages — umplanen lohnt erst, wenn ihr unterwegs seid."
                : "Für diesen Tag sind keine Blockzeiten gespeichert."
            return
        }

        isRedistributing = true
        defer { isRedistributing = false }

        guard let location = await locationProvider.currentLocation() else {
            redistributeBlockedReason =
                "Ohne Standort lässt sich nicht umplanen — der Plan müsste raten, wo ihr seid."
            return
        }

        struct Body: Encodable {
            let legIndex: Int
            let dayIndex: Int
            let currentBlockId: String
            let remainingMinutes: Int
            let position: TripCoordinate
        }
        do {
            let response: RedistributeResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(plan.id)/redistribute",
                body: Body(
                    legIndex: legIndex,
                    dayIndex: dayIndex,
                    currentBlockId: block.id,
                    remainingMinutes: TripDayTimeline.remainingMinutes(of: block, at: minutes),
                    position: TripCoordinate(
                        lat: location.coordinate.latitude,
                        lon: location.coordinate.longitude,
                    ),
                ),
            )
            apply(TripPlanResponse(plan: response.plan, droppedBlocks: nil))
            displaced = response.displaced
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Drag a spot into another block or day (§8.4).
    func move(_ stop: TripStop, toDayIndex: Int, toBlockId: String, position: Int? = nil) async {
        guard let plan else { return }
        struct Body: Encodable {
            let stopId: Int
            let legIndex: Int
            let toDayIndex: Int
            let toBlockId: String
            let toPosition: Int?
        }
        do {
            let response: MoveStopResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(plan.id)/stops/move",
                body: Body(
                    stopId: stop.rowId,
                    legIndex: legIndex,
                    toDayIndex: toDayIndex,
                    toBlockId: toBlockId,
                    toPosition: position,
                ),
            )
            apply(TripPlanResponse(plan: response.plan, droppedBlocks: nil))
            overfullBlockIds = Set(response.overfullBlockIds)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Pin a spot, or release it (§8.4).
    func setPinned(_ stop: TripStop, _ pinned: Bool) async {
        guard let plan else { return }
        struct Body: Encodable {
            let stopId: Int
            let pinned: Bool
        }
        do {
            let response: TripPlanResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(plan.id)/stops/pin",
                body: Body(stopId: stop.rowId, pinned: pinned),
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
