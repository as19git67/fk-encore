import SwiftUI

public struct ContentView: View {
    @Environment(AuthManager.self) private var authManager
    @Environment(\.scenePhase) private var scenePhase

    public init() {}

    public var body: some View {
        Group {
            if authManager.isAuthenticated {
                MainTabView()
            } else {
                LoginView()
            }
        }
        .animation(.easeInOut, value: authManager.isAuthenticated)
        .task {
            // Inject the AuthManager into APIClient so requests can attach the token.
            await APIClient.shared.setAuthManager(authManager)
        }
        .onChange(of: scenePhase) { _, newPhase in
            // If the initial restore ran while the device was locked (background
            // launch / pre-first-unlock), recover the session when the user
            // brings the app forward — instead of showing the login screen.
            if newPhase == .active {
                authManager.retryRestoreIfNeeded()
            }
        }
    }
}

struct MainTabView: View {
    @State private var feedViewModel = FeedViewModel()

    var body: some View {
        TabView {
            Tab("Feed", systemImage: "house") {
                NavigationStack {
                    FeedView(viewModel: feedViewModel)
                }
            }
            .badge(feedViewModel.unreadCount)

            Tab("Alben", systemImage: "rectangle.stack") {
                NavigationStack {
                    AlbumsListView()
                }
            }

            Tab("Trip", systemImage: "map") {
                NavigationStack {
                    TripView()
                }
            }

            Tab("Suche", systemImage: "magnifyingglass") {
                NavigationStack {
                    SearchView()
                }
            }

            Tab("Einstellungen", systemImage: "gearshape") {
                NavigationStack {
                    AdminView()
                }
            }
        }
        .task {
            await feedViewModel.refreshUnreadCount()
        }
        .task {
            // Cold-launch auto-resume: `applicationWillEnterForeground` only
            // fires when the process was suspended and resumed, never on a
            // fresh launch. If the OS suspended and later jetsam-killed the
            // app while a sync was interrupted mid-run (the common case when
            // backgrounding without power — see BackgroundSyncManager.
            // runFullSync), the next open is a cold launch and would
            // otherwise sit idle until the user taps "Jetzt synchronisieren"
            // again. This view appears once per cold launch (and once per
            // login), so firing the same auto-continue here closes that gap.
            // `pipelineLock` in runFullSync makes this a no-op if a
            // foreground-resume or background task is already running.
            BackgroundSyncManager.shared.handleForegroundResume()
        }
    }
}
