import AppIntents
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
                    AppDeepLinkRouter.shared.handle(url)
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

// MARK: - App Shortcuts

/// The intents live in the package (`TripIntents.swift`); App Intents
/// finds them through this bridge.
struct FKPhotosAppIntents: AppIntentsPackage {
    static var includedPackages: [any AppIntentsPackage.Type] {
        [FKPhotosIntents.self]
    }
}

/// The app's shortcuts for the Shortcuts app, Siri, Spotlight and the Action
/// button. App Shortcuts must be declared in the app target; the intents
/// live in the package (`TripIntents.swift`, `PhotoIntents.swift`).
///
/// Phrases are what Siri listens for; each must contain the app name.
/// Entity-taking intents (album, person) are not listed here on purpose:
/// an App Shortcut phrase can carry an entity only as an enumerated
/// parameter, and albums are open-ended. They stay reachable through the
/// Shortcuts app and through Siri's own „Öffne Album Urlaub in F4mil Photos"
/// resolution once the app has been used once.
struct FKPhotosShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: RememberHereIntent(),
            phrases: [
                "Das hier merken in \(.applicationName)",
                "Merke diesen Ort in \(.applicationName)",
            ],
            shortTitle: "Das hier merken",
            systemImageName: "mappin.and.ellipse"
        )
        AppShortcut(
            intent: BackUpNowIntent(),
            phrases: [
                "Jetzt sichern mit \(.applicationName)",
                "Fotos sichern mit \(.applicationName)",
                "\(.applicationName) synchronisieren",
            ],
            shortTitle: "Jetzt sichern",
            systemImageName: "arrow.triangle.2.circlepath"
        )
        AppShortcut(
            intent: SearchPhotosIntent(),
            // A phrase may carry a parameter only when it is an AppEnum or
            // AppEntity; the free-text query is asked for after the phrase.
            phrases: [
                "Suche in \(.applicationName)",
                "Fotos suchen in \(.applicationName)",
            ],
            shortTitle: "Fotos suchen",
            systemImageName: "magnifyingglass"
        )
        AppShortcut(
            intent: ShowLatestRecapIntent(),
            phrases: [
                "Zeige den Rückblick in \(.applicationName)",
                "Rückblick in \(.applicationName)",
            ],
            shortTitle: "Rückblick zeigen",
            systemImageName: "sparkles"
        )
        AppShortcut(
            intent: OpenReviewQueueIntent(),
            phrases: [
                "Gruppen-Review in \(.applicationName)",
                "Fotos aussortieren in \(.applicationName)",
            ],
            shortTitle: "Gruppen-Review",
            systemImageName: "checklist"
        )
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
