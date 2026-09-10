import SwiftUI

public struct ContentView: View {
    @Environment(AuthManager.self) private var authManager
    @Environment(\.scenePhase) private var scenePhase
    /// Where a review-queue deep link (a notification tap, or the
    /// `f4milphotos://review-queue` URL) should land — see the router's own
    /// comment (#968, proposal 6).
    @State private var deepLinkRouter = ReviewDeepLinkRouter.shared

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
        .task(id: authManager.currentUser?.id) {
            // Which photos this user has edited, fetched once for the whole
            // app. Recipes are per user, so signing in as someone else has to
            // drop the set rather than carry it over.
            TransformedPhotosIndex.shared.configure(userId: authManager.currentUser?.id)
        }
        .task(id: authManager.currentUser?.id) {
            // The home-screen badge, read once at launch. Signed out there is
            // nobody to have unread comments, and the icon should say so.
            guard authManager.currentUser != nil else {
                await CommentBadge.shared.clear()
                return
            }
            await CommentBadge.shared.refresh()
        }
        .onChange(of: scenePhase) { _, newPhase in
            // If the initial restore ran while the device was locked (background
            // launch / pre-first-unlock), recover the session when the user
            // brings the app forward — instead of showing the login screen.
            if newPhase == .active {
                authManager.retryRestoreIfNeeded()
                // Comments may have arrived while the app was away; the icon
                // is the only place that can say so before it is opened.
                Task { await CommentBadge.shared.refresh() }
            }
        }
        .onOpenURL { url in
            deepLinkRouter.handle(url)
        }
        .fullScreenCover(isPresented: $deepLinkRouter.isPresentingReviewQueue) {
            NavigationStack {
                ReviewQueueView()
            }
        }
    }
}

struct MainTabView: View {
    @State private var feedViewModel = FeedViewModel()
    @State private var tripStore = TripStore.shared
    @State private var autoStart = TripAutoStartMonitor.shared
    @State private var running = TripRunningPlan.shared
    /// Which tab is showing. Held rather than left to SwiftUI so the
    /// app can open on the trip while one is actually happening.
    @State private var selection: MainTab = .feed
    /// The tab is chosen once, at launch. Re-deciding later would move
    /// the screen under somebody's thumb.
    @State private var didChooseTab = false

    var body: some View {
        TabView(selection: $selection) {
            Tab("Feed", systemImage: "house", value: MainTab.feed) {
                NavigationStack {
                    FeedView(viewModel: feedViewModel)
                }
            }
            .badge(feedViewModel.unreadCount)

            Tab("Alben", systemImage: "rectangle.stack", value: MainTab.albums) {
                NavigationStack {
                    AlbumsListView()
                }
            }

            Tab("Trip", systemImage: tripStore.isActive ? "map.fill" : "map", value: MainTab.trip) {
                NavigationStack {
                    TripView()
                }
            }
            // A running trip is signalled two ways so it's unmistakable in the
            // tab bar: the icon switches to its filled variant, and a badge dot
            // appears (the same dynamic mechanism the Feed unread badge uses).
            //
            // The badge doubles as the quietest layer of the auto-start
            // suggestion (docs/ios-trip-mode.md §9.2): if the notification was
            // denied or dismissed and the user never opened the Trip tab, the
            // dot is what's left to say there is something waiting.
            .badge(tripStore.isActive || autoStart.pendingSuggestion != nil ? Text("●") : nil)

            Tab("Suche", systemImage: "magnifyingglass", value: MainTab.search) {
                NavigationStack {
                    SearchView()
                }
            }

            Tab("Einstellungen", systemImage: "gearshape", value: MainTab.settings) {
                NavigationStack {
                    AdminView()
                }
            }
        }
        .task {
            await feedViewModel.refreshUnreadCount()
        }
        .task {
            // Where the app opens: on the trip, while there is one. The
            // feed is the right answer for the other fifty weeks (§8.5).
            await running.refresh()
            guard !didChooseTab else { return }
            didChooseTab = true
            if TripLaunchRoute.opensOnTrip(
                tripModeActive: tripStore.isActive,
                planRunningToday: running.plan != nil,
            ) {
                selection = .trip
            }
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

/// The tabs of the app, so one of them can be chosen from code.
enum MainTab: Hashable {
    case feed, albums, trip, search, settings
}
