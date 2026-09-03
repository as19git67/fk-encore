import Foundation
import UserNotifications

/// Whether the app may say „neue Gruppen warten", and the switch to turn it
/// off.
enum ReviewQueueNotificationPreferences {
    private static let enabledKey = "review-queue-notifications-enabled"

    /// On by default. A reminder nobody sees is the problem this is meant to
    /// solve, so defaulting it off would ship the fix disabled — and the
    /// permission prompt is only ever raised when there is genuinely something
    /// to say, so „on" costs nothing until it has news.
    static var isEnabled: Bool {
        get {
            guard let stored = UserDefaults.standard.object(forKey: enabledKey) as? Bool else {
                return true
            }
            return stored
        }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }
}

/// Tells the user when new similar-photo groups have shown up (#968,
/// proposal 5).
///
/// **This is a local notification, not push.** The app registers no device
/// token and the server has no APNs path — adding one means an APNs key, a
/// server-side sender and device-token storage, which is its own piece of work.
/// What the proposal actually asks for („sobald neue Gruppen anstehen, z. B.
/// nach einem größeren Foto-Import") is reachable without any of that: the
/// background sync already runs on the phone, so the phone can notice the
/// queue grew and say so itself.
///
/// The decision of *whether* to speak is `ReviewQueueNotice.shouldNotify` —
/// pure and tested. This part is the plumbing around it.
@MainActor
enum ReviewQueueNotifier {

    /// Read the count and notify if it grew since the last time the user was
    /// told. Safe to call after every sync: it is silent unless there is news.
    static func checkAndNotify() async {
        guard ReviewQueueNotificationPreferences.isEnabled else { return }

        let counter = ReviewQueueCount.shared
        let previous = counter.lastNotified
        await counter.refresh()
        guard let current = counter.pending,
              ReviewQueueNotice.shouldNotify(previous: previous, current: current),
              let previous
        else { return }

        // Only ask for permission once there is something worth asking for.
        // A prompt on first launch, for a feature the user has not met yet, is
        // how notification permission gets denied for good.
        let center = UNUserNotificationCenter.current()
        guard (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) == true
        else { return }

        let content = UNMutableNotificationContent()
        content.title = "Fotos zum Aussortieren"
        content.body = ReviewQueueNotice.notificationBody(previous: previous, current: current)
        content.sound = .default
        content.badge = NSNumber(value: current)
        content.categoryIdentifier = ReviewQueueNotice.notificationCategoryId
        // What a tap opens. A cold launch has no view to route to, so the
        // target travels as the deep link the notification carries.
        content.userInfo = ["url": ReviewDeepLink.reviewQueueURL.absoluteString]

        // A fixed identifier, so a second round of new groups replaces the
        // first notice instead of stacking a pile of them in Notification
        // Centre.
        let request = UNNotificationRequest(
            identifier: ReviewQueueNotice.notificationRequestId,
            content: content,
            trigger: nil
        )
        try? await center.add(request)
        counter.recordNotified(current)
    }

    /// The category, registered alongside the trip ones. No actions: the only
    /// sensible response is „show me", which is what a plain tap does.
    static func notificationCategory() -> UNNotificationCategory {
        UNNotificationCategory(
            identifier: ReviewQueueNotice.notificationCategoryId,
            actions: [],
            intentIdentifiers: [],
            options: []
        )
    }
}
