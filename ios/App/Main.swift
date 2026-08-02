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

    /// Handles the trip auto-end suggestion's actions. Runs whether the app was
    /// foreground, backgrounded, or launched headless just for this — the
    /// system calls this delegate method in all three cases.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        guard response.notification.request.content.categoryIdentifier
                == TripAutoEndMonitor.notificationCategoryId
        else {
            completionHandler()
            return
        }
        Task { @MainActor in
            if response.actionIdentifier == TripAutoEndMonitor.endActionId {
                if let trip = TripStore.shared.activeTrip {
                    TripAutoEndMonitor.shared.dismissSuggestion(forTripAlbumId: trip.iosAlbumId)
                    TripStore.shared.endTrip()
                }
            } else if let trip = TripStore.shared.activeTrip {
                // Plain tap and the explicit "Weiter unterwegs" action both just
                // clear the suggestion — tapping only opens the app, it isn't an
                // implicit "yes".
                TripAutoEndMonitor.shared.dismissSuggestion(forTripAlbumId: trip.iosAlbumId)
            }
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
