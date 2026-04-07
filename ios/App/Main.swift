import SwiftUI
import UIKit
import FKPhotosLib

// MARK: - App Delegate

/// Handles UIKit lifecycle events that must run before the app finishes launching,
/// such as registering BGTaskScheduler handlers.
class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Background task handlers must be registered before the app finishes launching.
        BackgroundSyncManager.shared.register()
        return true
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Schedule the next sync whenever the app moves to the background.
        BackgroundSyncManager.shared.scheduleNextSyncIfNeeded()
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
