import CoreLocation
import Foundation
import UIKit
import UserNotifications

/// The collection speaking up on its own (§20.2).
///
/// Significant-change monitoring, the same service `TripAutoEndMonitor`
/// uses: iOS wakes the app every few hundred metres of movement and
/// costs practically nothing in between. Deliberately **not** geofences
/// — those are capped at twenty per app and the trip's visit monitor
/// has first claim on them (§7.1), and a collection of forty ideas
/// could not be fenced anyway.
///
/// What leaves the device is a coordinate and a radius, and only when
/// the brake in `TripIdeaNotice` lets it: the server rounds it before
/// storing anything, and nothing here keeps a track.
///
/// Everything decidable lives next door and is tested there — whether
/// to ask, and what the sentence says. What is left here is the
/// CoreLocation plumbing and one network call, which CI cannot run.
@MainActor
final class TripIdeaNoticeMonitor: NSObject, CLLocationManagerDelegate {
    static let shared = TripIdeaNoticeMonitor()

    static let notificationCategoryId = "ideas.nearby"
    private static let notificationId = "ideas.nearby.notice"

    private let manager = CLLocationManager()
    private var isMonitoring = false

    private override init() {
        super.init()
        manager.delegate = self
    }

    /// Start watching, if the household asked for it.
    ///
    /// Idempotent, and a no-op while the switch is off — which is the
    /// default. Called on launch and whenever the switch changes.
    func startIfEnabled() {
        guard TripIdeaNoticePreferences.isEnabled() else { return stop() }
        guard !isMonitoring else { return }
        isMonitoring = true

        let status = manager.authorizationStatus
        if status == .notDetermined || status == .authorizedWhenInUse {
            // Without "Always" the service still runs, but iOS stops
            // delivering once the app is fully terminated — the notice
            // then only works while the app is alive, which is a
            // weaker promise rather than a broken one.
            manager.requestAlwaysAuthorization()
        }
        manager.startMonitoringSignificantLocationChanges()
        Task { await requestNotificationAuthorizationIfNeeded() }
        // A device that is already standing somewhere produces no
        // update at all, so the first look happens here.
        Task { await evaluateNow() }
    }

    func stop() {
        guard isMonitoring else { return }
        isMonitoring = false
        manager.stopMonitoringSignificantLocationChanges()
    }

    nonisolated func locationManager(
        _ manager: CLLocationManager,
        didUpdateLocations locations: [CLLocation],
    ) {
        Task { @MainActor in await self.evaluate(locations.last) }
    }

    /// Look now, from the last known position.
    func evaluateNow() async {
        await evaluate(manager.location)
    }

    private func evaluate(_ location: CLLocation?) async {
        guard TripIdeaNoticePreferences.isEnabled(), let location else { return }
        guard TripIdeaNotice.mayAsk(
            at: location,
            last: TripIdeaNoticePreferences.lastAsk(),
        ) else { return }

        // Remembered *before* the call, not after: a failed request has
        // still woken the server, and a retry loop that asks again on
        // the next update is exactly the nagging §6.4 forbids.
        TripIdeaNoticePreferences.rememberAsk(at: location)

        struct Body: Encodable {
            let lat: Double
            let lon: Double
            let radiusM: Int
            let markSuggested: Bool
        }
        do {
            let response: TripIdeaNearbyResponse = try await APIClient.shared.post(
                "/trip-planner/ideas/nearby",
                body: Body(
                    lat: location.coordinate.latitude,
                    lon: location.coordinate.longitude,
                    radiusM: TripIdeaNotice.radiusM,
                    // True here and nowhere else: *this* is the meaning
                    // the server's quiet week was written for (§20.2).
                    markSuggested: true,
                ),
            )
            await notify(about: response.ideas)
        } catch {
            // Silent on purpose. Nobody asked for this, so nobody should
            // be told that it did not work.
        }
    }

    private func notify(about ideas: [TripNearIdea]) async {
        guard let sentence = TripIdeaNotice.sentence(for: ideas) else { return }
        // In the foreground the list is a tap away and a banner would
        // be the app talking over itself.
        guard UIApplication.shared.applicationState != .active else { return }

        let content = UNMutableNotificationContent()
        content.title = sentence.title
        content.body = sentence.body
        content.categoryIdentifier = Self.notificationCategoryId
        content.sound = .default

        try? await UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: Self.notificationId, content: content, trigger: nil),
        )
    }

    private func requestNotificationAuthorizationIfNeeded() async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .notDetermined else { return }
        _ = try? await center.requestAuthorization(options: [.alert, .sound])
    }
}
