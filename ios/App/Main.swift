import SwiftUI
import UIKit
import UserNotifications
import FKPhotosLib

// MARK: - App Delegate

/// Handles UIKit lifecycle events that must run before the app finishes launching,
/// such as registering BGTaskScheduler handlers.
class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Background task handlers must be registered before the app finishes launching.
        BackgroundSyncManager.shared.register()
        // Handles the Trip auto-end suggestion's notification actions
        // ("Trip beenden" / "Weiter unterwegs") even when they arrive while the
        // app isn't running — the system launches it headless to deliver them.
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Schedule the next sync whenever the app moves to the background.
        BackgroundSyncManager.shared.scheduleNextSyncIfNeeded()
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Items the system aborted mid-upload (background suspension cancels
        // the URLSession task) get marked as failed with a transient error
        // message. Reset those back to `.pending` and kick off another drain
        // so the user doesn't see ghost failures on every app re-open.
        BackgroundSyncManager.shared.handleForegroundResume()
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// Handles the trip suggestions' notification actions. Runs whether the app
    /// was foreground, backgrounded, or launched headless just for this — the
    /// system calls this delegate method in all three cases.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let category = response.notification.request.content.categoryIdentifier
        let action = response.actionIdentifier

        switch category {
        case TripAutoEndMonitor.notificationCategoryId:
            Task { @MainActor in
                TripAutoEndMonitor.shared.handleNotificationAction(action)
                completionHandler()
            }
        case TripAutoStartMonitor.notificationCategoryId:
            Task { @MainActor in
                TripAutoStartMonitor.shared.handleNotificationAction(action)
                completionHandler()
            }
        case ReviewQueueNotice.notificationCategoryId:
            // No action buttons on this one — any tap on it means „show me",
            // which is the deep link it was posted with (#968).
            Task { @MainActor in
                if let urlString = response.notification.request.content.userInfo["url"] as? String,
                   let url = URL(string: urlString) {
                    ReviewDeepLinkRouter.shared.handle(url)
                }
                completionHandler()
            }
        default:
            completionHandler()
        }
    }

    /// Shows the suggestion as a banner even while the app is in the
    /// foreground — otherwise `UNUserNotificationCenter` suppresses it
    /// silently, and `TripView`'s own banner (reading the same
    /// `pendingSuggestion`) wouldn't appear until the next view refresh.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}

// MARK: - App Entry Point

@main
struct FKPhotosEntry: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @State private var authManager = AuthManager()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(authManager)
        }
    }
}
