import CoreSpotlight
import SwiftUI

public struct ContentView: View {
    @Environment(AuthManager.self) private var authManager
    @Environment(\.scenePhase) private var scenePhase
    /// Where a deep link (a notification tap, a universal link, an
    /// `f4milphotos://…` URL) should land — see the router's own comment
    /// (#768 §5a). The tab bar takes it once it exists, so a link that
    /// arrives on the login screen is kept until after sign-in.
    @State private var deepLinkRouter = AppDeepLinkRouter.shared

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
        // Both the app scheme and universal links (`https://<server>/app/…`)
        // arrive here under the SwiftUI lifecycle.
        .onOpenURL { url in
            deepLinkRouter.handle(url)
        }
        // A tap on a Spotlight result (#768 §2) carries the item's unique
        // identifier; it becomes the same deep link every other source uses.
        .onContinueUserActivity(CSSearchableItemActionType) { activity in
            guard let identifier = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String,
                  let link = SpotlightItems.deepLink(forIdentifier: identifier) else { return }
            deepLinkRouter.open(link)
        }
        .task(id: authManager.currentUser?.id) {
            // The text index follows the library; a launch is a cheap
            // moment to catch up on what was recognised since. Rate-limited
            // and opt-in inside.
            guard authManager.currentUser != nil else { return }
            await SpotlightIndexer.shared.syncPhotos()
        }
    }
}

struct MainTabView: View {
    @State private var feedViewModel = FeedViewModel()
    /// Deep links land here: the tab bar is the one place that can pick a
    /// tab, push a screen and present a cover (#768 §5a).
    @State private var router = AppDeepLinkRouter.shared
    @State private var feedPath = NavigationPath()
    @State private var albumsPath = NavigationPath()
    @State private var tripStore = TripStore.shared
    @State private var autoStart = TripAutoStartMonitor.shared
    @State private var autoEnd = TripAutoEndMonitor.shared
    @State private var running = TripRunningPlan.shared
    /// "Das hier merken" asked for by the App Shortcut: the Trip tab
    /// does the work, so this is where the app goes.
    @State private var captureRequest = TripIdeaCaptureRequest.shared
    /// Which tab is showing. Held rather than left to SwiftUI so the
    /// app can open on the trip while one is actually happening.
    @State private var selection: MainTab = .feed
    /// The tab is chosen once, at launch. Re-deciding later would move
    /// the screen under somebody's thumb.
    @State private var didChooseTab = false

    var body: some View {
        TabView(selection: $selection) {
            Tab("Feed", systemImage: "house", value: MainTab.feed) {
                NavigationStack(path: $feedPath) {
                    FeedView(viewModel: feedViewModel)
                }
            }
            .badge(feedViewModel.unreadCount)

            Tab("Alben", systemImage: "rectangle.stack", value: MainTab.albums) {
                NavigationStack(path: $albumsPath) {
                    AlbumsListView()
                }
            }

            Tab("Trip", systemImage: running.isTravelling ? "map.fill" : "map", value: MainTab.trip) {
                NavigationStack {
                    TripView()
                }
            }
            // A running trip is signalled two ways so it's unmistakable in the
            // tab bar: the icon switches to its filled variant, and a badge dot
            // appears (the same dynamic mechanism the Feed unread badge uses).
            //
            // The badge doubles as the quietest layer of both suggestions
            // (docs/ios-trip-mode.md §9): if the notification was denied or
            // dismissed and the user never opened the Trip tab, the dot is
            // what's left to say there is something waiting — a trip to
            // start, or one to end.
            .badge(
                tripStore.isActive
                    || autoStart.pendingSuggestion != nil
                    || autoEnd.pendingSuggestion != nil
                    ? Text("●") : nil
            )

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
        .onChange(of: captureRequest.isRequested, initial: true) { _, requested in
            // Not a launch decision: the shortcut said where to go.
            if requested { selection = .trip }
        }
        .onChange(of: router.pending, initial: true) { _, pending in
            guard pending != nil else { return }
            // A link said where to go; the launch rule below must not move
            // the screen again afterwards.
            didChooseTab = true
            guard let navigation = router.takePending() else { return }
            switch navigation {
            case .album(let id):
                selection = .albums
                albumsPath = NavigationPath([id])
            case .person(let id):
                selection = .albums
                var path = NavigationPath()
                path.append(PersonsRef())
                path.append(PersonRef(id: id))
                albumsPath = path
            case .recaps:
                selection = .feed
                feedPath = NavigationPath([RecapsRef()])
            case .feed:
                selection = .feed
                feedPath = NavigationPath()
            }
        }
        .fullScreenCover(isPresented: $router.isPresentingReviewQueue) {
            NavigationStack {
                ReviewQueueView()
            }
        }
        .fullScreenCover(item: $router.presentedPhoto) { photo in
            NavigationStack {
                PhotoFullscreenView(photo: photo)
            }
        }
        .fullScreenCover(item: $router.presentedRecap) { item in
            RecapPlayerView(recapId: item.id)
        }
        .sheet(item: $router.browserURL) { item in
            SafariSheet(url: item.url) { router.browserURL = nil }
                .ignoresSafeArea()
        }
        .alert(
            "Link konnte nicht geöffnet werden",
            isPresented: Binding(
                get: { router.resolveError != nil },
                set: { if !$0 { router.resolveError = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(router.resolveError ?? "")
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
