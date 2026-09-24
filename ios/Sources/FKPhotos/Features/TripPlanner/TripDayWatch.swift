import CoreLocation
import Foundation
import UIKit
import UserNotifications

/// The day noticing that it is not going to plan (§7.1, §8.5).
///
/// Out of the first real-world trial: the app knew a plan and a clock
/// and never put them together. Arrival was set for noon and happened
/// at five, and nothing asked; the Live Activity said "Mittag" at
/// dinner; the day screen marked the block it had been opened on.
/// Everything in this file exists to make the day *move*.
///
/// Three pure rules and one piece of plumbing:
///
///   - `TripBehindCheck` turns a day and a minute into the question
///     `TripArrivalHeuristic` answers — "will what is left fit in what
///     is left?" That heuristic was written for §7.1 and tested, and
///     until now nothing ever called it.
///   - `TripLateArrival` is the arrival day's own rule: the planned
///     arrival has passed, nothing is done, the group is only now at
///     the quarters — offer to plan the rest from here and let the
///     morning that never happened go.
///   - `TripDayNotices` carries both offers to the screen and, when the
///     app is not in front, to a notification. Offered, never done:
///     "ungefragt umzuräumen wäre übergriffig" (§7.1).
///
/// What wakes it is whatever wakes the app: a geofence, a significant
/// move, a foreground, a minute passing on the day screen. None of
/// that is a timer of its own — the day has no clock the phone does
/// not already keep.
enum TripBehindCheck {

    /// The heuristic's question, asked of the day at one minute.
    ///
    /// Nil when the clock is outside every block, or the plan carries
    /// no block times — then there is nothing to be behind on.
    static func situation(
        day: TripDay,
        at minutes: Int,
        alreadySuggested: (String) -> Bool,
    ) -> (block: TripBlock, situation: TripArrivalHeuristic.Situation)? {
        guard let block = TripDayTimeline.block(in: day, at: minutes),
              let start = block.startMinutes
        else { return nil }
        // What is neither done nor skipped, with the way to it — the
        // same sum the block card shows as "used".
        let open = block.stops.filter { $0.stopStatus == .planned }
        let work = open.reduce(0) { $0 + $1.dwellMinutes + $1.travelFromPrevious.minutes }
        return (block, TripArrivalHeuristic.Situation(
            elapsedMinutes: max(0, minutes - start),
            remainingMinutes: TripDayTimeline.remainingMinutes(of: block, at: minutes),
            remainingWorkMinutes: work,
            remainingStops: open.count,
            alreadySuggested: alreadySuggested(block.id),
        ))
    }
}

/// The arrival day's rule (§4.2, §5).
///
/// The planned arrival is the frame of day one; nothing compared it
/// with the day as it happened. Now something does — and only on the
/// first day of a leg, only while nothing is done yet (a family that
/// has ticked off a stop has arrived, whatever the clock says), and
/// only once the planned time is properly behind.
enum TripLateArrival {

    /// Later than this past the planned arrival counts as late. Half
    /// an hour is a slow check-in, not a lost afternoon.
    static let toleranceMinutes = 30

    struct Situation: Equatable {
        /// When the plan expected the group, minutes past midnight.
        /// Nil for a leg nobody gave an arrival — then there is nothing
        /// to be late against.
        let arriveMinutes: Int?
        let nowMinutes: Int
        let isFirstDayOfLeg: Bool
        /// Stops done or skipped today.
        let settledStops: Int
        /// Whether the phone has been seen at the quarters today — a
        /// fence entry or a significant-change fix inside it.
        let atQuarters: Bool
        let alreadyAsked: Bool
    }

    enum Verdict: Equatable {
        case quiet
        /// Offer to plan from here. `certain` when the phone is at the
        /// quarters — the sentence then states the arrival rather than
        /// asking about it.
        case offer(certain: Bool)
    }

    static func evaluate(_ s: Situation) -> Verdict {
        guard s.isFirstDayOfLeg, let planned = s.arriveMinutes else { return .quiet }
        if s.alreadyAsked || s.settledStops > 0 { return .quiet }
        guard s.nowMinutes >= planned + toleranceMinutes else { return .quiet }
        return .offer(certain: s.atQuarters)
    }

    /// What the card or the notification says.
    static func sentence(planned: Int, now: Int, certain: Bool) -> String {
        certain
            ? "Angekommen um \(TripClock.format(now)) statt \(TripClock.format(planned)). "
                + "Den Tag ab jetzt umplanen? Was vorher lag, geht zurück zu den Kandidaten."
            : "Geplant war die Ankunft um \(TripClock.format(planned)), jetzt ist es "
                + "\(TripClock.format(now)). Seid ihr schon da? Dann lässt sich der Tag ab "
                + "jetzt umplanen."
    }
}

/// One offer the day makes, in the words to show.
struct TripDayOffer: Equatable, Identifiable {
    enum Kind: String { case behind, lateArrival }
    let kind: Kind
    let planId: Int
    let legIndex: Int
    let dayIndex: Int
    /// The block it is about, for the behind offer.
    let blockId: String?
    let sentence: String

    var id: String { "\(kind.rawValue)/\(planId)/\(legIndex)/\(dayIndex)/\(blockId ?? "-")" }
}

/// A "Umplanen" pressed on a notification, waiting for the day screen
/// to carry it out — the screen is where the position and the plan are.
struct TripPendingReplan: Equatable {
    let planId: Int
    let arrivedLate: Bool
}

/// The running trip's day, loaded the way the Live Activity loads it:
/// from the server when it answers, from the offline bundle when not
/// (§3.9). A background wake in a tunnel still has the plan.
struct TripRunningDay {
    let plan: TripPlan
    let position: TripDayPosition
    let leg: TripLeg
    let day: TripDay
    /// The day's light, for the Activity's hint. Nil when nobody
    /// computed it.
    let light: TripDayLight?

    @MainActor
    static func load(now: Date = Date()) async -> TripRunningDay? {
        guard let planId = TripRunningPlan.shared.plan?.id else { return nil }
        let bundle: TripOfflineBundle
        if let fetched = try? await fetch(planId: planId) {
            bundle = fetched
        } else if let snapshot = TripOfflineStore.shared.load(planId: planId) {
            bundle = snapshot.bundle
        } else {
            return nil
        }
        guard let position = bundle.plan.position(on: now) else { return nil }
        return of(plan: bundle.plan,
                  light: bundle.lightOfDay(legIndex: position.legIndex, dayIndex: position.dayIndex),
                  now: now)
    }

    /// From a plan already in hand — what the day screen has.
    static func of(plan: TripPlan, light: TripDayLight?, now: Date) -> TripRunningDay? {
        guard let position = plan.position(on: now),
              let leg = plan.legs.first(where: { $0.position == position.legIndex }),
              let day = leg.days.first(where: { $0.dayIndex == position.dayIndex }),
              day.detailed
        else { return nil }
        return TripRunningDay(plan: plan, position: position, leg: leg, day: day, light: light)
    }

    private static func fetch(planId: Int) async throws -> TripOfflineBundle {
        try await APIClient.shared.get(
            "/trip-planner/plans/\(planId)/bundle",
            query: ["utcOffsetMinutes": String(TimeZone.current.secondsFromGMT() / 60)],
        )
    }

    /// Is `day` the first of its leg? By index, because that is what
    /// the arrival frames (§4.2).
    var isFirstDayOfLeg: Bool {
        leg.days.map(\.dayIndex).min() == day.dayIndex
    }
}

/// One wake, both listeners: the Live Activity and the offers read
/// the same day, so it is loaded once.
enum TripDayPulse {
    @MainActor
    static func tick(_ reason: TripDayNotices.Wake) async {
        let running = await TripRunningDay.load(now: TripDayNotices.shared.now())
        await TripDayActivityManager.shared.refresh(running)
        if let running {
            TripDayNotices.shared.evaluate(running)
        } else {
            TripDayNotices.shared.clearOffers()
        }
    }
}

/// What the day has said and been answered, so it does not say it
/// twice — and does not stop saying it too early.
///
/// Two lists, because they answer two questions. *Notified* is "has a
/// banner gone out for this" — once, so a second wake in the same
/// block is quiet. *Dismissed* is "was it waved away or acted on" —
/// until then the card stays on the screen, and an app opened from
/// that banner has to find the card it promised.
enum TripDayNoticePreferences {
    private static let notifiedKey = "trip.day.notified"
    private static let dismissedKey = "trip.day.dismissed"
    private static let quartersSeenKey = "trip.day.quartersSeen"

    static func blockKey(planId: Int, dayIndex: Int, blockId: String, on day: String) -> String {
        "block/\(planId)/\(day)/\(dayIndex)/\(blockId)"
    }

    static func arrivalKey(planId: Int, dayIndex: Int, on day: String) -> String {
        "arrival/\(planId)/\(day)/\(dayIndex)"
    }

    static func quartersKey(planId: Int, dayIndex: Int, on day: String) -> String {
        "quarters/\(planId)/\(day)/\(dayIndex)"
    }

    static func wasNotified(_ key: String, store: UserDefaults = .standard) -> Bool {
        (store.stringArray(forKey: notifiedKey) ?? []).contains(key)
    }

    static func markNotified(_ key: String, store: UserDefaults = .standard) {
        remember(key, under: notifiedKey, store: store)
    }

    /// The phone was seen at the quarters on this day: a fence entry
    /// or a fix inside it. What turns "seid ihr schon da?" into
    /// "angekommen um".
    static func wasAtQuarters(_ key: String, store: UserDefaults = .standard) -> Bool {
        (store.stringArray(forKey: quartersSeenKey) ?? []).contains(key)
    }

    static func markAtQuarters(_ key: String, store: UserDefaults = .standard) {
        remember(key, under: quartersSeenKey, store: store)
    }

    static func wasDismissed(_ key: String, store: UserDefaults = .standard) -> Bool {
        (store.stringArray(forKey: dismissedKey) ?? []).contains(key)
    }

    static func markDismissed(_ key: String, store: UserDefaults = .standard) {
        remember(key, under: dismissedKey, store: store)
    }

    /// A short list, newest last: a trip has a dozen blocks a day, and
    /// what was asked last month is nothing anybody will be asked again.
    private static func remember(_ key: String, under name: String, store: UserDefaults) {
        var keys = store.stringArray(forKey: name) ?? []
        guard !keys.contains(key) else { return }
        keys.append(key)
        if keys.count > 200 { keys.removeFirst(keys.count - 200) }
        store.set(keys, forKey: name)
    }
}

/// The offers, and how they reach somebody (§7.1).
@Observable @MainActor
public final class TripDayNotices {
    public static let shared = TripDayNotices()

    public nonisolated static let notificationCategoryId = "trip.day"
    nonisolated static let replanActionId = "trip.day.replan"
    nonisolated static let laterActionId = "trip.day.later"
    private static let notificationId = "trip.day.notice"

    /// "The afternoon is getting tight — replan?" for the block the
    /// group is in. Nil when there is nothing to say.
    private(set) var behind: TripDayOffer?
    /// "Arrived at five instead of noon — replan from here?"
    private(set) var lateArrival: TripDayOffer?
    /// A "Umplanen" from a notification, for the day screen to run.
    var pendingReplan: TripPendingReplan?

    /// What "now" is. Injectable so a test is not at the mercy of the
    /// minute it runs in.
    var now: () -> Date = { Date() }

    private init() {}

    /// What woke the day. Every place the app comes alive: the day
    /// screen's minute, a foreground, the visit monitor's fences and
    /// moves. None of them is a timer of this class's own.
    enum Wake { case foreground, minute, location, fenceEntered, fenceExited }

    /// No running day: nothing to offer.
    func clearOffers() {
        behind = nil
        lateArrival = nil
    }

    /// Look at the day and decide whether it has something to say.
    /// Cheap enough to call often — a few sums over the day in hand.
    func evaluate(_ running: TripRunningDay) {
        let date = now()
        let minutes = TripDayTimeline.minutesOfDay(date)
        let isoDay = TripCalendar.isoDay(date, timeZone: .current)
        let planId = running.plan.id
        let dayIndex = running.day.dayIndex
        let arrivalKey = TripDayNoticePreferences.arrivalKey(planId: planId, dayIndex: dayIndex, on: isoDay)
        let quartersKey = TripDayNoticePreferences.quartersKey(planId: planId, dayIndex: dayIndex, on: isoDay)

        // The arrival first: on a day nobody has reached yet, "you are
        // behind on the Mittag block" is true and useless — the group
        // is on the motorway, and a redistribution from there would
        // plan the afternoon around a service station.
        let settled = running.day.blocks.flatMap(\.stops).filter { $0.stopStatus != .planned }.count
        let atQuarters = TripDayNoticePreferences.wasAtQuarters(quartersKey)
        let arrival = TripLateArrival.evaluate(TripLateArrival.Situation(
            arriveMinutes: running.leg.arriveMinutes,
            nowMinutes: minutes,
            isFirstDayOfLeg: running.isFirstDayOfLeg,
            settledStops: settled,
            atQuarters: atQuarters,
            alreadyAsked: TripDayNoticePreferences.wasDismissed(arrivalKey),
        ))
        if case .offer(let certain) = arrival, let planned = running.leg.arriveMinutes {
            lateArrival = TripDayOffer(
                kind: .lateArrival,
                planId: planId,
                legIndex: running.position.legIndex,
                dayIndex: dayIndex,
                blockId: nil,
                sentence: TripLateArrival.sentence(planned: planned, now: minutes, certain: certain),
            )
            behind = nil
            // A banner only once the phone is *at* the quarters: one on
            // the motorway asking whether you have arrived is the
            // nagging §6.4 forbids. The card asks the open question
            // whenever the app is opened.
            if certain, !TripDayNoticePreferences.wasNotified(arrivalKey) {
                TripDayNoticePreferences.markNotified(arrivalKey)
                notify(title: "Später angekommen als geplant", offer: lateArrival!, arrivedLate: true)
            }
            return
        }
        lateArrival = nil

        // The arrival day before the quarters are reached: quiet, for
        // the reason above. Once a stop is settled the group is plainly
        // there, whatever the fence saw.
        if running.isFirstDayOfLeg, running.leg.arriveMinutes != nil, !atQuarters, settled == 0 {
            behind = nil
            return
        }

        guard let found = TripBehindCheck.situation(
            day: running.day,
            at: minutes,
            alreadySuggested: { blockId in
                TripDayNoticePreferences.wasDismissed(TripDayNoticePreferences.blockKey(
                    planId: planId, dayIndex: dayIndex, blockId: blockId, on: isoDay))
            },
        ) else {
            behind = nil
            return
        }
        let (block, situation) = found
        switch TripArrivalHeuristic.evaluate(situation) {
        case .quiet:
            // An offer already on screen for this block stays: "quiet"
            // here only means it was waved away, or is not (yet) tight.
            if behind?.blockId != block.id { behind = nil }
        case .offer(let reason):
            behind = TripDayOffer(
                kind: .behind,
                planId: planId,
                legIndex: running.position.legIndex,
                dayIndex: dayIndex,
                blockId: block.id,
                sentence: reason,
            )
            // One banner per block, whatever happens afterwards.
            let key = TripDayNoticePreferences.blockKey(
                planId: planId, dayIndex: dayIndex, blockId: block.id, on: isoDay)
            if !TripDayNoticePreferences.wasNotified(key) {
                TripDayNoticePreferences.markNotified(key)
                notify(title: "\(block.label) wird knapp", offer: behind!, arrivedLate: false)
            }
        }
    }

    /// The phone was seen at the quarters today. From the anchor fence
    /// or a significant-change fix inside it.
    func noteAtQuarters(planId: Int, dayIndex: Int) {
        let isoDay = TripCalendar.isoDay(now(), timeZone: .current)
        TripDayNoticePreferences.markAtQuarters(
            TripDayNoticePreferences.quartersKey(planId: planId, dayIndex: dayIndex, on: isoDay))
    }

    /// "Später" / "Lassen" on a card: the offer goes and stays gone for
    /// this block or day.
    func dismiss(_ offer: TripDayOffer) {
        TripDayNoticePreferences.markDismissed(key(of: offer))
        if behind == offer { behind = nil }
        if lateArrival == offer { lateArrival = nil }
    }

    /// The day screen ran the redistribution: what was offered is
    /// answered, and is not offered again for the same block or day.
    func clearAfterReplan() {
        for offer in [behind, lateArrival].compactMap({ $0 }) {
            TripDayNoticePreferences.markDismissed(key(of: offer))
        }
        behind = nil
        lateArrival = nil
        pendingReplan = nil
    }

    private func key(of offer: TripDayOffer) -> String {
        let isoDay = TripCalendar.isoDay(now(), timeZone: .current)
        switch offer.kind {
        case .behind:
            return TripDayNoticePreferences.blockKey(
                planId: offer.planId, dayIndex: offer.dayIndex, blockId: offer.blockId ?? "-", on: isoDay)
        case .lateArrival:
            return TripDayNoticePreferences.arrivalKey(planId: offer.planId, dayIndex: offer.dayIndex, on: isoDay)
        }
    }

    // MARK: - Notifications

    /// The category with its two buttons, registered at launch with
    /// the others (`TripNotificationCategories.registerAll()`).
    nonisolated static func notificationCategory() -> UNNotificationCategory {
        let replan = UNNotificationAction(identifier: replanActionId, title: "Umplanen", options: [.foreground])
        let later = UNNotificationAction(identifier: laterActionId, title: "Später", options: [])
        return UNNotificationCategory(
            identifier: notificationCategoryId,
            actions: [replan, later],
            intentIdentifiers: [],
            options: [],
        )
    }

    /// From the app delegate: a tap or a button on the day's notification.
    ///
    /// "Umplanen" cannot run here — it needs a position and the plan,
    /// which the day screen has — so it is left for that screen to
    /// pick up, and the app opens on it. "Später" and a plain tap
    /// leave the offer where it is (opening the app is not a yes).
    public func handleNotificationAction(_ actionIdentifier: String, userInfo: [AnyHashable: Any]) {
        guard let planId = userInfo["planId"] as? Int else { return }
        if actionIdentifier == Self.replanActionId {
            pendingReplan = TripPendingReplan(
                planId: planId,
                arrivedLate: userInfo["arrivedLate"] as? Bool ?? false,
            )
            AppDeepLinkRouter.shared.handle(urlString: AppDeepLink.url(for: .tripDay(planId: planId)).absoluteString)
        }
    }

    private func notify(title: String, offer: TripDayOffer, arrivedLate: Bool) {
        // In front, the card is already on the day screen; a banner
        // over it would be the app talking over itself.
        guard UIApplication.shared.applicationState != .active else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = offer.sentence
        content.categoryIdentifier = Self.notificationCategoryId
        content.sound = .default
        content.userInfo = ["planId": offer.planId, "arrivedLate": arrivedLate]
        let request = UNNotificationRequest(identifier: Self.notificationId, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    /// Ask once. A denial means the offers only ever appear as cards
    /// on the day screen, which is where they live anyway.
    func requestNotificationAuthorizationIfNeeded() async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .notDetermined else { return }
        _ = try? await center.requestAuthorization(options: [.alert, .sound])
    }
}
