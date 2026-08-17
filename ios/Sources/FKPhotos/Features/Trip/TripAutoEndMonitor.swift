import CoreLocation
import Foundation
import UIKit
import UserNotifications

/// Watches for "the device is back home" while a trip is active and, once
/// that has held for long enough, suggests ending the trip — never ends it
/// automatically (`docs/ios-trip-mode.md` §9). Deliberately reachable while
/// the app is not in the foreground: it uses the significant-change location
/// service, which can relaunch a suspended or terminated app to deliver an
/// update, and raises the suggestion as an actionable local notification so
/// the user can answer it without opening the app.
///
/// This is a heuristic layered *on top of* the manual "Beenden" button in
/// `TripView` — it never replaces it, and doing nothing leaves the trip
/// running exactly as if the monitor didn't exist.
@MainActor
public final class TripAutoEndMonitor: NSObject, CLLocationManagerDelegate {
    public static let shared = TripAutoEndMonitor()

    /// Public so `Main.swift` (the App target, a separate module from
    /// `FKPhotosLib`) can tell this category apart from any future
    /// notification type before routing a response to `handleNotificationAction`.
    /// `nonisolated` — plain string constants, and `Main.swift` reads this one
    /// from its `UNUserNotificationCenterDelegate` callback before hopping onto
    /// the main actor, so it must be readable without that isolation.
    public nonisolated static let notificationCategoryId = "trip.autoend"
    nonisolated static let endActionId = "trip.autoend.end"
    nonisolated static let dismissActionId = "trip.autoend.dismiss"

    private let manager = CLLocationManager()
    private var isMonitoring = false

    private override init() {
        super.init()
        manager.delegate = self
    }

    /// The auto-end category (its actions). Registered together with every
    /// other category at launch — see `TripNotificationCategories.registerAll()`
    /// — so a notification delivered while the app isn't running still carries
    /// its buttons.
    static func notificationCategory() -> UNNotificationCategory {
        let end = UNNotificationAction(
            identifier: endActionId, title: "Trip beenden", options: [.destructive]
        )
        let dismiss = UNNotificationAction(
            identifier: dismissActionId, title: "Weiter unterwegs", options: []
        )
        return UNNotificationCategory(
            identifier: notificationCategoryId,
            actions: [end, dismiss],
            intentIdentifiers: [],
            options: []
        )
    }

    /// Starts significant-change location monitoring for the active trip.
    /// Idempotent. Requests "Always" authorization — without it the service
    /// still runs but iOS stops delivering updates once the app is fully
    /// terminated rather than just suspended, so the suggestion becomes
    /// foreground/background-only instead of working after a jetsam kill.
    /// Either way this never blocks trip start: a denied/undetermined status
    /// just means fewer updates, not a broken trip.
    ///
    /// `resetTracking` must be true only when a *new* trip begins. Resuming
    /// monitoring for a trip that was already running has to keep the arrival
    /// clock — see `TripAutoEndPreferences.resetArrivalTracking()`.
    func start(resetTracking: Bool = true) {
        guard !isMonitoring else { return }
        isMonitoring = true
        if resetTracking {
            disarm()
            TripAutoEndPreferences.resetArrivalTracking()
        }

        let status = manager.authorizationStatus
        if status == .notDetermined || status == .authorizedWhenInUse {
            manager.requestAlwaysAuthorization()
        }
        manager.startMonitoringSignificantLocationChanges()

        Task { await requestNotificationAuthorizationIfNeeded() }
        // Evaluate straight away from the last known location instead of
        // waiting for movement: a device that is already sitting at home
        // produces no significant-change update at all.
        Task { await evaluateNow() }
    }

    /// Stops monitoring. Called when the trip ends — the suggestion is only
    /// meaningful for a running trip, and continuing to monitor afterwards
    /// would just burn battery for the closed-trip catch-up, which doesn't
    /// need location at all.
    func stop() {
        guard isMonitoring else { return }
        isMonitoring = false
        manager.stopMonitoringSignificantLocationChanges()
        disarm()
        TripAutoEndPreferences.resetArrivalTracking()
    }

    /// Resumes monitoring after a cold launch if a trip was already active —
    /// `isMonitoring` starts false every process launch, so without this a
    /// trip started in a previous run would silently stop being watched the
    /// moment the app was killed and relaunched.
    func resumeIfTripActive() {
        guard TripStore.shared.isActive else { return }
        start(resetTracking: false)
    }

    /// Re-runs the heuristic against the last known location, without waiting
    /// for a location update to arrive.
    ///
    /// Needed because significant-change updates are movement-driven: arriving
    /// home means the device goes still, so the "stayed here long enough"
    /// moment produces no callback. Called on foreground resume and from the
    /// sync pass, which between them cover every occasion the app is awake.
    func evaluateNow() async {
        guard TripStore.shared.isActive else { return }
        guard let location = manager.location else { return }
        await handle(location)
    }

    /// Clears the pending suggestion (if it matches the given trip) and starts
    /// the cooldown, so the next arrival at home doesn't immediately re-ask.
    /// Called both when the user acts on the notification/banner and when
    /// `endTrip()` runs for any other reason (the suggestion would otherwise
    /// dangle, referencing a trip that no longer exists).
    func dismissSuggestion(forTripAlbumId albumId: String) {
        guard TripAutoEndPreferences.pendingSuggestion?.tripIosAlbumId == albumId else { return }
        TripAutoEndPreferences.pendingSuggestion = nil
        TripAutoEndPreferences.lastSuggestionAt = Date()
        disarm()
    }

    /// Entry point for `Main.swift`'s `UNUserNotificationCenterDelegate`: reacts
    /// to a tap or action on the auto-end notification (already confirmed to be
    /// this category by the caller). Kept as a single public method — rather
    /// than exposing `TripStore`/`ActiveTrip` across the module boundary — so
    /// the App target's public surface stays this one call, mirroring
    /// `BackgroundSyncManager.shared.register()`.
    ///
    /// "Trip beenden" ends the trip; a plain tap and the explicit "Weiter
    /// unterwegs" action both just clear the suggestion (tapping only opens the
    /// app, it isn't an implicit "yes").
    public func handleNotificationAction(_ actionIdentifier: String) {
        guard let trip = TripStore.shared.activeTrip else { return }
        dismissSuggestion(forTripAlbumId: trip.iosAlbumId)
        if actionIdentifier == Self.endActionId {
            TripStore.shared.endTrip()
        }
    }

    // MARK: - CLLocationManagerDelegate

    // `public` because the class itself is public and conforms to a public
    // protocol: Swift requires a public type's protocol-witness methods to be
    // at least as visible as the requirement, even though nothing outside this
    // module is meant to call these directly (CLLocationManager does).
    public nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        Task { @MainActor in await self.handle(location) }
    }

    public nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // Significant-change failures are transient (no fix, airplane mode) and
        // self-resolve on the next update; nothing to reconcile here.
    }

    // MARK: - Evaluation

    private func handle(_ location: CLLocation) async {
        guard isMonitoring, let trip = TripStore.shared.activeTrip else { return }
        // Switching the suggestions off mid-trip has to take back an ask that
        // is already scheduled, not just stop new ones.
        guard TripSuggestionSettings.enabled else { disarm(); return }
        guard TripAutoEndPreferences.pendingSuggestion == nil else { return }

        guard let home = await TripHomeLocation.resolve() else { return }
        // Re-check: `resolve()` can await a network round-trip, and the trip may
        // have been ended (or answered) while we were waiting.
        guard isMonitoring, TripStore.shared.activeTrip?.iosAlbumId == trip.iosAlbumId else { return }

        let atHome = TripAutoEndHeuristic.isAtHome(location.coordinate, home: home)
        let decision = TripAutoEndHeuristic.evaluate(
            candidateSince: TripAutoEndPreferences.homeArrivalCandidateSince,
            lastSuggestionAt: TripAutoEndPreferences.lastSuggestionAt,
            isAtHome: atHome,
            now: Date()
        )
        TripAutoEndPreferences.homeArrivalCandidateSince = decision.candidateSince

        if decision.shouldDisarm { disarm() }
        if let fireAt = decision.armFireAt { arm(for: trip, at: fireAt) }
        guard decision.shouldSuggest else { return }

        raiseSuggestion(for: trip)
    }

    /// Notification identifier for a trip's suggestion. One per trip, reused by
    /// both the armed (time-triggered) and the immediate notification, so the
    /// two can never stack into a double ask — posting the same identifier
    /// replaces whatever was pending.
    private static func notificationId(for trip: ActiveTrip) -> String {
        "trip.autoend.\(trip.iosAlbumId)"
    }

    /// Schedules the suggestion for `fireAt`.
    ///
    /// This is what carries the suggestion across the app not running. The
    /// system owns the timer, so the prompt arrives on a parked phone whose app
    /// was suspended hours ago — which is exactly the situation the arrival at
    /// home creates.
    ///
    /// Re-arming to the same instant is skipped so a burst of evaluations
    /// (foreground resume plus a sync pass plus a location update) doesn't
    /// churn the scheduled request.
    private func arm(for trip: ActiveTrip, at fireAt: Date) {
        guard TripAutoEndPreferences.armedFireAt != fireAt else { return }
        let delay = fireAt.timeIntervalSinceNow
        guard delay > 0 else { return }

        let id = Self.notificationId(for: trip)
        TripAutoEndPreferences.armedFireAt = fireAt
        TripAutoEndPreferences.armedNotificationId = id
        let request = UNNotificationRequest(
            identifier: id,
            content: suggestionContent(for: trip),
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: delay, repeats: false)
        )
        UNUserNotificationCenter.current().add(request)
    }

    /// Cancels a scheduled suggestion. Safe to call when nothing is armed.
    ///
    /// Only *pending* (not yet delivered) requests are removed — a notification
    /// the user has already been shown stays in Notification Centre, where
    /// answering it is still meaningful.
    private func disarm() {
        guard let id = TripAutoEndPreferences.armedNotificationId else { return }
        TripAutoEndPreferences.armedFireAt = nil
        TripAutoEndPreferences.armedNotificationId = nil
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [id])
    }

    private func suggestionContent(for trip: ActiveTrip) -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = "Bist du zurück?"
        content.body = "Sieht so aus, als wärst du wieder zuhause. Trip \"\(trip.name)\" beenden?"
        content.categoryIdentifier = Self.notificationCategoryId
        content.sound = .default
        return content
    }

    private func raiseSuggestion(for trip: ActiveTrip) {
        TripAutoEndPreferences.pendingSuggestion = PendingAutoEndSuggestion(
            tripIosAlbumId: trip.iosAlbumId, raisedAt: Date()
        )
        TripAutoEndPreferences.lastSuggestionAt = Date()

        // While the app is in the foreground the `TripView` banner already
        // carries the suggestion, and an armed notification may have fired
        // moments ago — posting another one here would re-alert for something
        // the user is already looking at.
        guard UIApplication.shared.applicationState != .active else { return }

        let request = UNNotificationRequest(
            identifier: Self.notificationId(for: trip),
            content: suggestionContent(for: trip),
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }

    /// Requests notification permission if not yet determined. A denial just
    /// means the suggestion only ever surfaces as the in-app `TripView` banner
    /// (`pendingSuggestion` is set regardless of this), not as a background
    /// notification — the heuristic itself doesn't depend on it.
    private func requestNotificationAuthorizationIfNeeded() async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .notDetermined else { return }
        _ = try? await center.requestAuthorization(options: [.alert, .sound])
    }
}
