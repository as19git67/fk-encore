import CoreLocation
import Foundation
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

    /// Registers the notification category (actions) once at launch, so a
    /// notification delivered while the app isn't running still has them —
    /// categories must be registered before the notification is presented, not
    /// necessarily before it's scheduled, but doing it at launch is simplest.
    static func registerNotificationCategory() {
        let end = UNNotificationAction(
            identifier: endActionId, title: "Trip beenden", options: [.destructive]
        )
        let dismiss = UNNotificationAction(
            identifier: dismissActionId, title: "Weiter unterwegs", options: []
        )
        let category = UNNotificationCategory(
            identifier: notificationCategoryId,
            actions: [end, dismiss],
            intentIdentifiers: [],
            options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([category])
    }

    /// Starts significant-change location monitoring for the active trip.
    /// Idempotent. Requests "Always" authorization — without it the service
    /// still runs but iOS stops delivering updates once the app is fully
    /// terminated rather than just suspended, so the suggestion becomes
    /// foreground/background-only instead of working after a jetsam kill.
    /// Either way this never blocks trip start: a denied/undetermined status
    /// just means fewer updates, not a broken trip.
    func start() {
        guard !isMonitoring else { return }
        isMonitoring = true
        TripAutoEndPreferences.resetArrivalTracking()

        let status = manager.authorizationStatus
        if status == .notDetermined || status == .authorizedWhenInUse {
            manager.requestAlwaysAuthorization()
        }
        manager.startMonitoringSignificantLocationChanges()

        Task { await requestNotificationAuthorizationIfNeeded() }
    }

    /// Stops monitoring. Called when the trip ends — the suggestion is only
    /// meaningful for a running trip, and continuing to monitor afterwards
    /// would just burn battery for the closed-trip catch-up, which doesn't
    /// need location at all.
    func stop() {
        guard isMonitoring else { return }
        isMonitoring = false
        manager.stopMonitoringSignificantLocationChanges()
        TripAutoEndPreferences.resetArrivalTracking()
    }

    /// Resumes monitoring after a cold launch if a trip was already active —
    /// `isMonitoring` starts false every process launch, so without this a
    /// trip started in a previous run would silently stop being watched the
    /// moment the app was killed and relaunched.
    func resumeIfTripActive() {
        guard TripStore.shared.isActive else { return }
        start()
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
        guard TripAutoEndPreferences.pendingSuggestion == nil else { return }

        guard let home = await TripHomeLocation.resolve() else { return }

        let atHome = TripAutoEndHeuristic.isAtHome(location.coordinate, home: home)
        let decision = TripAutoEndHeuristic.evaluate(
            candidateSince: TripAutoEndPreferences.homeArrivalCandidateSince,
            lastSuggestionAt: TripAutoEndPreferences.lastSuggestionAt,
            isAtHome: atHome,
            now: Date()
        )
        TripAutoEndPreferences.homeArrivalCandidateSince = decision.candidateSince
        guard decision.shouldSuggest else { return }

        raiseSuggestion(for: trip)
    }

    private func raiseSuggestion(for trip: ActiveTrip) {
        TripAutoEndPreferences.pendingSuggestion = PendingAutoEndSuggestion(
            tripIosAlbumId: trip.iosAlbumId, raisedAt: Date()
        )
        TripAutoEndPreferences.lastSuggestionAt = Date()

        let content = UNMutableNotificationContent()
        content.title = "Bist du zurück?"
        content.body = "Sieht so aus, als wärst du wieder zuhause. Trip \"\(trip.name)\" beenden?"
        content.categoryIdentifier = Self.notificationCategoryId
        content.sound = .default

        let request = UNNotificationRequest(
            identifier: "trip.autoend.\(trip.iosAlbumId)", content: content, trigger: nil
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
