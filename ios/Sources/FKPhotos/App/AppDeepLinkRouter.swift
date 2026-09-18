import Foundation
import Observation

/// Where a deep link lands, independent of the tab bar (#768 §5a).
///
/// The review queue is not any tab's own screen — the entry points that lead
/// to it (feed banner, hub row, toolbar badge) all push it locally, but a
/// notification tap or a cold-launch URL has no tab context to push from.
/// This is a single switch `MainTabView` reads: it picks the tab, pushes the
/// screen or presents the cover, so „open album 12" means the same thing
/// regardless of where the app happened to be — and regardless of whether the
/// URL came from the app scheme or from the web address.
///
/// A link that arrives before login is kept in `pending` and taken once the
/// tab bar exists; a signed-out phone tapping a shared link should land on
/// the album after signing in, not on the feed.
@MainActor
@Observable
public final class AppDeepLinkRouter {
    // `Main.swift` (a separate module — the App target's own Package.swift
    // build never compiles it, which is how this stayed internal and broke
    // the app build without CI noticing) calls `.shared.handle(_:)` from its
    // notification-tap delegate, so both have to be public.
    public static let shared = AppDeepLinkRouter()

    /// The link waiting to be taken by the tab bar. Set by `handle`, cleared
    /// by `takePending`.
    private(set) var pending: AppDeepLink?

    /// Presentation state the tab bar binds its covers to. These are covers
    /// rather than pushes because their targets belong to no tab.
    var isPresentingReviewQueue = false
    var presentedPhoto: PhotoWithCuration?
    var presentedRecap: RecapPlayerItem?
    /// A web URL the app could not take itself — a shared album the signed-in
    /// user has no access to — shown in an in-app Safari sheet rather than
    /// bounced to Safari, which would hand it straight back.
    var browserURL: BrowserURL?

    /// Set for the one link that fails to resolve, so a tap on a deleted
    /// photo says so instead of doing nothing.
    var resolveError: String?

    /// Where the tab bar should navigate. Distinct from the covers above
    /// because a push needs the tab's own `NavigationPath`.
    enum Navigation: Equatable {
        case album(id: Int)
        case person(id: Int)
        case recaps
        case feed
        case search
    }

    /// A query waiting for the search tab (an App Intent, #766). The tab
    /// takes it when it appears; a flag rather than a call because the tab
    /// may not exist yet when the intent fires.
    private(set) var pendingSearchQuery: String?

    func takeSearchQuery() -> String? {
        defer { pendingSearchQuery = nil }
        return pendingSearchQuery
    }

    public init() {}

    /// The configured server, read synchronously so a URL can be classified
    /// on the spot. Mirrors what `APIClient` reads at start-up.
    var serverURL: URL? {
        (SharedStorage.defaults.string(forKey: SharedStorage.serverURLKey)
            ?? UserDefaults.standard.string(forKey: APIClient.serverURLKey))
            .flatMap(URL.init)
    }

    public func handle(_ url: URL) {
        guard let link = AppDeepLink.parse(url, serverURL: serverURL) else { return }
        open(link)
    }

    /// A URL as text — from a notification payload. A web-relative path
    /// (`/app/fotos/alben/12`, what the server's push payloads carry) is
    /// resolved against the configured server first, so the server never
    /// needs to know its own origin.
    public func handle(urlString: String) {
        guard let url = Self.resolve(urlString, serverURL: serverURL) else { return }
        handle(url)
    }

    /// Pure, hence `nonisolated`: the class is main-actor bound, and a test
    /// wants to call this without an actor hop.
    nonisolated static func resolve(_ urlString: String, serverURL: URL?) -> URL? {
        if urlString.hasPrefix("/") {
            guard let serverURL else { return nil }
            return URL(string: urlString, relativeTo: serverURL)?.absoluteURL
        }
        return URL(string: urlString)
    }

    /// Open a target the app produced itself (a Spotlight hit, an intent).
    func open(_ link: AppDeepLink) {
        pending = link
    }

    /// Called by the tab bar once it exists: resolves the pending link into
    /// either a cover (handled here) or a navigation (returned for the tab
    /// bar to perform). Nil when nothing waits, or when the link needs no
    /// navigation.
    func takePending() -> Navigation? {
        guard let link = pending else { return nil }
        pending = nil
        switch link {
        case .reviewQueue:
            isPresentingReviewQueue = true
            return nil
        case .recap(let id):
            presentedRecap = RecapPlayerItem(id: id)
            return nil
        case .photo(let id):
            Task { await presentPhoto(id) }
            return nil
        case .sharedAlbum(let token):
            Task { await resolveSharedAlbum(token) }
            return nil
        case .album(let id):
            return .album(id: id)
        case .person(let id):
            return .person(id: id)
        case .recaps:
            return .recaps
        case .feed:
            return .feed
        case .search(let query):
            pendingSearchQuery = query
            return .search
        }
    }

    /// A shared-album resolution that ends in a push has to reach the tab
    /// bar after the fact; it is delivered the same way an incoming link is.
    private func navigateLater(_ link: AppDeepLink) {
        pending = link
    }

    private func presentPhoto(_ id: Int) async {
        do {
            presentedPhoto = try await PhotoFetch.byId(id)
        } catch {
            resolveError = "Das Foto konnte nicht geöffnet werden."
        }
    }

    /// A shared link is the web URL `/app/albums/shared/<token>`. When the
    /// signed-in user is a member of that album, the app's own album screen is
    /// the better place for it; otherwise the public page is shown in-app.
    private func resolveSharedAlbum(_ token: String) async {
        struct PublicAlbumLite: Decodable { let id: Int }
        struct AlbumLite: Decodable { let id: Int }
        do {
            let publicAlbum: PublicAlbumLite = try await APIClient.shared.get("/albums/public/\(token)")
            // Membership check: the album endpoint answers 403/404 for
            // non-members, and the public page is right for them.
            let _: AlbumLite = try await APIClient.shared.get("/albums/\(publicAlbum.id)")
            navigateLater(.album(id: publicAlbum.id))
        } catch {
            if let url = AppDeepLink.webURL(for: .sharedAlbum(token: token), serverURL: serverURL) {
                browserURL = BrowserURL(url: url)
            } else {
                resolveError = "Der geteilte Link konnte nicht geöffnet werden."
            }
        }
    }
}

/// Identifiable wrapper so `sheet(item:)` can present a Safari view.
struct BrowserURL: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}
