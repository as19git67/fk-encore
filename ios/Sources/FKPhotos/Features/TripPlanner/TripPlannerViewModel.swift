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
    /// Set while a pending trip is being filled in (§4.3).
    private(set) var isFilling = false
    /// Why the fill-in did not happen — usually "die Karten sind noch
    /// nicht da", which is a state rather than a fault.
    var fillBlockedReason: String?
    var errorMessage: String?
    /// The day's light (§7.3), for the hint on a spot card. Nil until
    /// it has been asked for, and empty for a trip with no dates —
    /// there is no sun without a day.
    private(set) var light: TripDayLight?
    /// The day's weather (§7.2). Reported, never acted on: nothing in
    /// this build reorders a block because it rained.
    private(set) var forecast: TripDayForecast?
    /// The weather's offer for this day, once it has been asked for
    /// (§7.1). Nil means nothing is on offer and nothing is on screen.
    var weatherProposal: TripWeatherProposal?
    /// Set while the offer is being fetched or carried out.
    private(set) var isWeatherReplanning = false
    /// What the last accepted offer actually moved — the sentence to
    /// show afterwards, so the day does not silently rearrange itself.
    private(set) var weatherMoves: [TripWeatherMove] = []
    /// Spots this trip has turned down (§5), for the list that brings
    /// them back.
    private(set) var hiddenSpots: [TripHiddenSpot] = []
    /// Ideas from the collection that lie in one of this trip's legs
    /// (§20.3). Offered, never taken over by themselves.
    private(set) var planIdeas: [TripIdeaForPlan] = []
    private(set) var isLoadingPlanIdeas = false
    /// What the last "für später merken" did, in words.
    var keptForNextTime: String?
    /// Set while a hard time is being written or removed (§4.4): both
    /// re-plan the trip, which is not instant.
    private(set) var isSavingFixpoint = false

    /// Set when what is on screen came from the stored bundle rather
    /// than from the server (§3.9), with the moment it was stored. The
    /// day plan says so: a plan that is quietly three days old is the
    /// one way this feature could do harm.
    private(set) var offlineSince: Date?
    /// When this plan was last stored for offline use, whether or not
    /// it is being shown from there. Nil means nothing is stored.
    private(set) var bundleStoredAt: Date?
    /// Set while the bundle is being fetched, for the button to say so.
    private(set) var isDownloadingBundle = false
    /// Where the bundle is kept. Injectable so tests do not write into
    /// the real Application Support directory.
    var offlineStore: TripOfflineStore = .shared

    /// Which leg and day are on screen. Both are positions within their
    /// parent, not row ids, because that is how the endpoints address
    /// them.
    var legIndex: Int = 0
    var dayIndex: Int = 0

    /// Set once the screen has landed on a day of its own accord, so
    /// that reloading after a change does not yank the traveller back
    /// to today while they are looking at Thursday.
    private var hasPositioned = false

    /// What "today" means. Injectable so the tests are not at the mercy
    /// of the date the suite happens to run on.
    var now: () -> Date = { Date() }

    /// Spots whose "Warum hier?" is open (§8.3), keyed by `osmRef`.
    var expandedReasons: Set<String> = []

    /// Which plan this is. Read by the screens that need to address
    /// the same plan through a different endpoint — searching for a
    /// place, reviewing a shared find.
    let planId: Int

    init(planId: Int) {
        self.planId = planId
    }

    /// Switch to another city of the trip (§4.2).
    ///
    /// Lands on today when that city is the one being travelled and on
    /// its first day otherwise — the same rule the screen uses when a
    /// trip is opened, because "which day of Osaka?" has the same
    /// answer whether you got there by opening the trip or by tapping
    /// across from Tokyo.
    func select(leg position: Int) {
        guard let plan, let leg = plan.legs.first(where: { $0.position == position })
        else { return }
        legIndex = position
        if let today = plan.position(on: now()), today.legIndex == position {
            dayIndex = today.dayIndex
        } else {
            dayIndex = leg.days.map(\.dayIndex).min() ?? 0
        }
    }

    var leg: TripLeg? {
        plan?.legs.first { $0.position == legIndex }
    }

    var day: TripDay? {
        leg?.days.first { $0.dayIndex == dayIndex }
    }

    /// Is the day on screen the day it is?
    ///
    /// Answered from the trip's dates, not from anything anybody
    /// pressed — the same rule the leg picker follows. Nil dates mean
    /// no: a trip nobody has placed in the year has no today.
    var isToday: Bool {
        guard let plan, let today = plan.position(on: now()) else { return false }
        return today.legIndex == legIndex && today.dayIndex == dayIndex
    }

    /// Every stop of the current day, in order across blocks — what the
    /// map numbers its pins by.
    var stopsOfDay: [TripStop] {
        day?.blocks.flatMap(\.stops) ?? []
    }

    /// Put a split block back together (§6.5): the branches go, and the
    /// block is planned once more as one, with the group in one place.
    func removeSplit(_ block: TripBlock) async {
        guard let index = day?.blocks.firstIndex(where: { $0.id == block.id }) else { return }
        do {
            struct Body: Encodable { let dayIndex: Int; let blockIndex: Int }
            let response: TripPlanResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/splits/remove",
                body: Body(dayIndex: dayIndex, blockIndex: index))
            plan = response.plan
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response: TripPlanResponse =
                try await APIClient.shared.get("/trip-planner/plans/\(planId)")
            apply(response)
            offlineSince = nil
            bundleStoredAt = offlineStore.storedAt(planId: planId)
            // Somebody who once asked for this trip to be available
            // offline meant "keep it", not "keep that one afternoon".
            // A plan changed at breakfast has to be the plan in the
            // pocket by the time the wifi is gone.
            if bundleStoredAt != nil {
                Task { await refreshBundleQuietly() }
            }
        } catch {
            // The plan from disk, but only when the server could not be
            // asked (§3.9). A "not found" is an answer and has to reach
            // the traveller as one.
            if TripOfflineReach.meansUnreachable(error),
               let snapshot = offlineStore.load(planId: planId) {
                apply(TripPlanResponse(plan: snapshot.bundle.plan, droppedBlocks: nil))
                offlineBundle = snapshot.bundle
                offlineSince = snapshot.storedAt
                bundleStoredAt = snapshot.storedAt
                errorMessage = nil
                light = snapshot.bundle.lightOfDay(legIndex: legIndex, dayIndex: dayIndex)
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }

    /// The bundle currently being shown from disk, if any — the source
    /// of the light hints while there is no network.
    private var offlineBundle: TripOfflineBundle?

    /// Fetch the whole plan and keep it (§3.9).
    ///
    /// Returns false when it could not be stored, so the screen can say
    /// so instead of showing a stamp that means nothing.
    @discardableResult
    func downloadBundle() async -> Bool {
        isDownloadingBundle = true
        defer { isDownloadingBundle = false }
        do {
            let bundle = try await fetchBundle()
            bundleStoredAt = try offlineStore.save(bundle, planId: planId)
            offlineBundle = bundle
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// Keeping an existing bundle current, without saying anything.
    ///
    /// Failure here is not worth a banner: the stored plan is still the
    /// stored plan, and an error over the day screen because a refresh
    /// did not go through would train people to ignore errors.
    private func refreshBundleQuietly() async {
        guard offlineStore.has(planId: planId) else { return }
        guard let bundle = try? await fetchBundle() else { return }
        bundleStoredAt = try? offlineStore.save(bundle, planId: planId)
        offlineBundle = bundle
    }

    private func fetchBundle() async throws -> TripOfflineBundle {
        try await APIClient.shared.get(
            "/trip-planner/plans/\(planId)/bundle",
            query: ["utcOffsetMinutes": String(TimeZone.current.secondsFromGMT() / 60)],
        )
    }

    /// Forget the stored plan. Somebody who says so after a trip means
    /// it, and a bundle nobody deletes is a plan that outlives the
    /// holiday on a full phone.
    func removeBundle() {
        offlineStore.remove(planId: planId)
        bundleStoredAt = nil
        offlineBundle = nil
    }

    /// The light for the day on screen (§7.3) — a hint, nothing more.
    ///
    /// One call per day rather than one per spot: the sun is the same
    /// sky for all of them, and the difference between two stops in one
    /// city is seconds. Failure is silent on purpose. A missing light
    /// hint is a line that does not appear; an error banner over the
    /// day plan because the sun could not be computed would be the
    /// tail wagging the dog.
    func loadLight() async {
        guard let plan, plan.legs.indices.contains(legIndex) else { return }
        struct Body: Encodable {
            let legIndex: Int
            let dayIndex: Int
            let utcOffsetMinutes: Int
        }
        do {
            light = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/light",
                body: Body(
                    legIndex: legIndex,
                    dayIndex: dayIndex,
                    // The clock the traveller is reading. Right where it
                    // matters — standing there — and the honest best
                    // guess when planning from home.
                    utcOffsetMinutes: TimeZone.current.secondsFromGMT() / 60,
                ),
            )
        } catch {
            // Offline the sun is still arithmetic somebody already did
            // — it travelled with the bundle (§7.3).
            light = offlineBundle?.lightOfDay(legIndex: legIndex, dayIndex: dayIndex)
        }
    }

    /// The weather for the day on screen (§7.2).
    ///
    /// Silent on failure, like the light: a plan is still a plan in the
    /// rain, and an error banner over the day because a forecast
    /// service is down would be the tail wagging the dog. The server
    /// already distinguishes "no forecast" from "fine weather"; this
    /// only has to not lose the distinction.
    func loadForecast() async {
        guard let plan, plan.legs.indices.contains(legIndex) else { return }
        struct Body: Encodable {
            let legIndex: Int
            let dayIndex: Int
            let utcOffsetMinutes: Int
        }
        do {
            forecast = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/weather",
                body: Body(
                    legIndex: legIndex,
                    dayIndex: dayIndex,
                    utcOffsetMinutes: TimeZone.current.secondsFromGMT() / 60,
                ),
            )
        } catch {
            forecast = nil
        }
    }

    /// Ask what the weather would change about this day (§7.2, §7.1).
    ///
    /// Two calls, and the split is the whole feature: this one saves
    /// nothing. The traveller reads the moves in plain words and
    /// decides — "ungefragt umzuräumen wäre übergriffig" (§7.1), and a
    /// forecast is a weaker reason to touch somebody's day than
    /// standing in the wrong place at the wrong time.
    ///
    /// Loud on failure, unlike the forecast itself: this one was asked
    /// for by tapping a button, and a button that silently does nothing
    /// is worse than an error.
    func proposeWeatherReplan() async {
        guard let plan, plan.legs.contains(where: { $0.position == legIndex }) else { return }
        isWeatherReplanning = true
        defer { isWeatherReplanning = false }
        do {
            weatherProposal = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/weather/proposal",
                body: WeatherReplanBody(
                    legIndex: legIndex,
                    dayIndex: dayIndex,
                    utcOffsetMinutes: TimeZone.current.secondsFromGMT() / 60,
                ),
            )
        } catch {
            weatherProposal = nil
            errorMessage = error.localizedDescription
        }
    }

    /// Do it, having been asked (§7.2).
    ///
    /// The server recomputes rather than replaying the proposal, so
    /// what comes back is what happened — not what was offered a
    /// while ago to a day that may since have moved on.
    func applyWeatherReplan() async {
        guard let plan, plan.legs.contains(where: { $0.position == legIndex }) else { return }
        isWeatherReplanning = true
        defer { isWeatherReplanning = false }
        do {
            let response: TripWeatherApplyResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/weather/apply",
                body: WeatherReplanBody(
                    legIndex: legIndex,
                    dayIndex: dayIndex,
                    utcOffsetMinutes: TimeZone.current.secondsFromGMT() / 60,
                ),
            )
            apply(TripPlanResponse(plan: response.plan, droppedBlocks: nil))
            weatherMoves = response.moves
            weatherProposal = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Put the offer away without doing it. Declining is an answer.
    func dismissWeatherProposal() {
        weatherProposal = nil
    }

    private struct WeatherReplanBody: Encodable {
        let legIndex: Int
        let dayIndex: Int
        let utcOffsetMinutes: Int
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

    /// Fill in a trip that was saved before its maps existed (§4.3).
    ///
    /// The server does this by itself on a timer once the import lands,
    /// so this button is for the impatient and for the case the timer
    /// cannot cover — an import that failed and was restarted. It is
    /// the same endpoint either way, and it refuses in words when the
    /// maps are still missing.
    func fillPending() async {
        guard let plan else { return }
        isFilling = true
        defer { isFilling = false }
        struct Empty: Encodable {}
        do {
            let response: TripPlanResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(plan.id)/plan", body: Empty())
            apply(response)
            fillBlockedReason = nil
        } catch {
            // "die Karten sind noch nicht da" is a state to wait out,
            // not a failure — shown as such rather than in red.
            fillBlockedReason = error.localizedDescription
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

    /// Write a title, a note and a link against one spot (§9.2, §10.4).
    ///
    /// Against the leg and the OSM reference, never against the stop
    /// row: a re-plan deletes and rewrites the day's stops, so a note
    /// kept on the row would last until the next settings change. The
    /// whole plan comes back, because a title changes what the day
    /// screen reads too.
    func saveNote(_ edit: TripSpotEdit) async {
        struct Body: Encodable {
            let osmRef: String
            let title: String
            let note: String
            let url: String
            let dwellMinutes: Int
            let photoStop: Bool
        }
        struct Response: Decodable {
            let spotNote: TripSpotNote?
        }
        do {
            let _: Response = try await APIClient.shared.patch(
                "/trip-planner/plans/\(planId)/legs/\(legIndex)/spot",
                body: Body(osmRef: edit.osmRef, title: edit.title, note: edit.note,
                           url: edit.url, dwellMinutes: edit.dwellMinutes,
                           photoStop: edit.photoStop),
            )
            // The written note reaches the screens through the plan,
            // which carries it onto every copy of the spot at once —
            // the pool row, the day row and the detail view.
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Put a candidate from the pool into a block (§5, §8.4).
    ///
    /// The traveller overruling the solver, which is a thing the
    /// concept wants to be possible: the solver picks what fits a
    /// budget, a person picks what they want. An overfull block is
    /// reported and coloured, never refused — §8.4 is explicit that the
    /// app shows the cost of the gesture rather than blocking it.
    func place(_ candidate: TripCandidate, inBlock blockId: String, onDay day: Int) async {
        struct Body: Encodable {
            let legIndex: Int
            let dayIndex: Int
            let blockId: String
            let osmRef: String
        }
        struct Response: Decodable {
            let plan: TripPlan
            let overfullBlockIds: [String]
        }
        do {
            let response: Response = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/pool/place",
                body: Body(legIndex: legIndex, dayIndex: day, blockId: blockId,
                           osmRef: candidate.osmRef),
            )
            plan = response.plan
            overfullBlockIds = Set(response.overfullBlockIds)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Take a candidate out of the pool — "not this".
    ///
    /// No tombstone: a re-plan may well find it again, because the leg
    /// really does still contain that museum. A hidden list of banished
    /// spots nobody could see or undo would be worse than the honest
    /// repeat.
    func drop(_ candidate: TripCandidate) async {
        struct Body: Encodable {
            let legIndex: Int
            let osmRef: String
        }
        struct Response: Decodable {
            let plan: TripPlan
            let dropped: Bool
        }
        do {
            let response: Response = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/pool/drop",
                body: Body(legIndex: legIndex, osmRef: candidate.osmRef),
            )
            plan = response.plan
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Put a hard time on the day on screen (§4.4).
    ///
    /// The frame, not the content: the server re-frames the day around
    /// it and re-plans, so what comes back is a day whose blocks have
    /// the minutes the train left them.
    func addFixpoint(
        label: String,
        at minutesOfDay: Int,
        kind: String,
        travelMinutes: Int,
        durationMinutes: Int,
    ) async {
        guard let plan, plan.legs.contains(where: { $0.position == legIndex }) else { return }
        struct Body: Encodable {
            let legIndex: Int
            let dayIndex: Int
            let label: String
            let at: String
            let kind: String
            let travelMinutes: Int
            let durationMinutes: Int
        }
        isSavingFixpoint = true
        defer { isSavingFixpoint = false }
        do {
            let response: TripPlanResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/fixpoints",
                body: Body(
                    legIndex: legIndex,
                    dayIndex: dayIndex,
                    label: label,
                    at: TripClock.format(minutesOfDay),
                    kind: kind,
                    travelMinutes: travelMinutes,
                    // A departure is an instant; only an appointment
                    // occupies time (§4.4).
                    durationMinutes: kind == "departure" ? 0 : durationMinutes,
                ),
            )
            apply(response)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Take one off again. The day gets its minutes back, so the server
    /// plans it again — a block still shortened for a train nobody
    /// catches would be wrong in the quietest possible way.
    func removeFixpoint(_ fixpoint: TripFixpoint) async {
        struct Body: Encodable { let fixpointId: Int }
        isSavingFixpoint = true
        defer { isSavingFixpoint = false }
        do {
            let response: TripPlanResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/fixpoints/remove",
                body: Body(fixpointId: fixpoint.rowId),
            )
            apply(response)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Take a planned spot off the day and put it back in the pool
    /// (§8.4) — "nicht heute Nachmittag", as opposed to hiding, which
    /// says "nicht auf dieser Reise".
    ///
    /// It comes back with the boost §5 gives a displaced spot, and the
    /// day is not re-planned around the gap: taking one spot out is not
    /// asking for the afternoon to be rearranged.
    func returnToPool(_ stop: TripStop) async {
        struct Body: Encodable { let stopId: Int }
        struct Response: Decodable {
            let plan: TripPlan
            let name: String?
        }
        do {
            let response: Response = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/stops/to-pool", body: Body(stopId: stop.rowId))
            plan = response.plan
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Turn a spot down for the whole trip (§5, §20.5).
    ///
    /// Not the same gesture as putting one back in the pool: this one
    /// says "and not next time either", which is the only way to stop
    /// the search proposing a place that is simply not wanted. It is
    /// reversible — `hiddenSpots` lists what a trip has turned down and
    /// `unhide` brings one back.
    func hide(osmRef: String) async {
        struct Body: Encodable { let osmRef: String }
        struct Response: Decodable {
            let plan: TripPlan
            let hidden: [TripHiddenSpot]
            let wasPlanned: Bool
        }
        do {
            let response: Response = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/spots/hide", body: Body(osmRef: osmRef))
            plan = response.plan
            hiddenSpots = response.hidden
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - The collection and this trip (§20.3)

    /// „Ihr habt vier Ideen für Lissabon gesammelt."
    ///
    /// A question, not a handover. An idea from last year is not
    /// automatically the wish of this trip, so this only asks what lies
    /// in a leg — and what the trip already has is **marked** rather
    /// than dropped from the list: seeing that it is there is the
    /// answer to the same question.
    func loadIdeasForPlan() async {
        isLoadingPlanIdeas = true
        defer { isLoadingPlanIdeas = false }
        do {
            let response: TripIdeasForPlanResponse = try await APIClient.shared.get(
                "/trip-planner/plans/\(planId)/ideas")
            planIdeas = response.ideas
            errorMessage = nil
        } catch {
            errorMessage = "Der Ideenvorrat ließ sich nicht abfragen."
        }
    }

    /// Take one idea into this trip's pool (§20.3).
    ///
    /// It goes the way a find goes (§9.2): right leg by position,
    /// duplicates merged, provenance kept — so the five rules live in
    /// one place rather than two. **The idea stays in the collection**:
    /// it is not consumed, only used.
    func takeIdea(_ idea: TripIdeaForPlan) async {
        struct Body: Encodable { let id: Int }
        do {
            let _: [String: String?] = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/ideas/take", body: Body(id: idea.id))
            errorMessage = nil
            // Both lists moved: the trip has a pool entry more, and the
            // idea is now marked as already here.
            await load()
            await loadIdeasForPlan()
        } catch {
            errorMessage = "\(idea.displayName) ließ sich nicht übernehmen."
        }
    }

    /// „Beim nächsten Mal" — what this trip did not use goes back into
    /// the collection (§20.3).
    ///
    /// The honest place for a spot nobody got to: better than a pool
    /// that disappears with the trip it hung off.
    func keepForNextTime(osmRefs: [String]) async {
        guard !osmRefs.isEmpty else { return }
        struct Body: Encodable { let osmRefs: [String] }
        do {
            let response: TripKeptForNextTimeResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/pool/to-ideas", body: Body(osmRefs: osmRefs))
            keptForNextTime = response.sentence
            errorMessage = nil
        } catch {
            errorMessage = "Das ließ sich nicht für später merken."
        }
    }

    /// Take the "no" back. The spot may be proposed again from the next
    /// re-plan on; nothing is put on a day here.
    func unhide(osmRef: String) async {
        struct Body: Encodable { let osmRef: String }
        struct Response: Decodable { let hidden: [TripHiddenSpot] }
        do {
            let response: Response = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/spots/unhide", body: Body(osmRef: osmRef))
            hiddenSpots = response.hidden
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// What this trip has turned down. Silent on failure: an empty list
    /// is what the screen shows anyway, and a banner over a settings
    /// page because a side list could not be fetched helps nobody.
    func loadHiddenSpots() async {
        struct Response: Decodable { let hidden: [TripHiddenSpot] }
        do {
            let response: Response = try await APIClient.shared.get(
                "/trip-planner/plans/\(planId)/hidden")
            hiddenSpots = response.hidden
        } catch {
            hiddenSpots = []
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
    /// - Parameter locationProvider: injectable for tests. Built here
    ///   rather than as a default argument because default arguments are
    ///   evaluated outside the actor, and `TripLocationProvider` is
    ///   main-actor isolated.
    func redistributeNow(
        now: Date = Date(),
        locationProvider: TripLocationProvider? = nil,
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

        // Only now, so a day with no running block never asks for a fix.
        let provider = locationProvider
            ?? TripLocationProvider(accuracy: kCLLocationAccuracyNearestTenMeters)
        guard let location = await provider.currentLocation() else {
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

    /// Take a plan an endpoint just returned.
    ///
    /// The screens that change the *shape* of a trip — its cities —
    /// live outside this view model but have to leave it holding the
    /// new plan, or the day behind them would still show the old one.
    func replace(with response: TripPlanResponse) {
        apply(response)
    }

    private func apply(_ response: TripPlanResponse) {
        plan = response.plan
        // Both describe the last action, not the plan: a red block and a
        // "back in the pool" list must not outlive the change that
        // produced them. Callers that still have something to say set
        // them again right after.
        overfullBlockIds = []
        displaced = []
        // A plan can come back with fewer legs or days than the screen
        // was showing — clamp rather than leave the view pointing at
        // something that no longer exists.
        if let plan {
            // A trip that is running opens on the day you are actually
            // on. That is what "starting a trip" amounts to here: there
            // is no button, because a button has to be pressed on the
            // one morning nobody has their phone out (§8.5).
            if !hasPositioned, let position = plan.position(on: now()) {
                legIndex = position.legIndex
                dayIndex = position.dayIndex
            }
            hasPositioned = true
            legIndex = min(legIndex, max(0, plan.legs.count - 1))
            if let leg = plan.legs.first(where: { $0.position == legIndex }) {
                dayIndex = min(dayIndex, max(0, leg.days.count - 1))
            }
        }
        errorMessage = nil
    }
}
