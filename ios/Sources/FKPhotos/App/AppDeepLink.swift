import Foundation

/// Where an incoming URL wants to go (#768 §5a).
///
/// Every "open X in the app" source — a notification tap, a widget, a
/// Spotlight result, an App Intent, a shared link, Handoff — produces a URL
/// and hands it here. There is one router (`AppDeepLinkRouter`) and one
/// parser, so „open album 12" means the same thing whether the URL came from
/// the app's own scheme or from the household's web address.
///
/// Two URL shapes parse to the same target:
///
/// - the app's own scheme, `f4milphotos://album/12`, which works without any
///   server change and is what notifications and widgets use;
/// - the web app's `https://<server>/app/fotos/alben/12`, which is what a
///   family member receives in a message. That one only reaches the app when
///   the server publishes an `apple-app-site-association` naming these paths
///   and the app carries the matching `applinks:` entitlement — see
///   `web/app-site-association.ts` and `DEPLOYMENT.md`.
///
/// Parsing is pure so the accepted and rejected shapes are testable without
/// an app around them.
enum AppDeepLink: Equatable, Sendable {
    /// `f4milphotos://review-queue` · `/app/fotos/review-queue`
    case reviewQueue
    /// `f4milphotos://album/12` · `/app/fotos/alben/12` · `/app/albums/12`
    case album(id: Int)
    /// `f4milphotos://shared-album/<token>` · `/app/albums/shared/<token>`
    case sharedAlbum(token: String)
    /// `f4milphotos://photo/34` · `/app/fotos/galerie?photoId=34` ·
    /// `/app/photos?photoId=34`
    case photo(id: Int)
    /// `f4milphotos://person/5` · `/app/fotos/personen?personId=5`
    case person(id: Int)
    /// `f4milphotos://recap/7` · `/app/fotos/rueckblicke?recapId=7`
    case recap(id: Int)
    /// `f4milphotos://recaps` · `/app/fotos/rueckblicke`
    case recaps
    /// `f4milphotos://feed` · `/app/fotos/feed`
    case feed
    /// `f4milphotos://search?q=…` — the search tab with the query submitted.
    /// App scheme only: the web has no URL for a search.
    case search(query: String)

    static let scheme = "f4milphotos"

    /// Path prefix the web app is served under (`web/static.ts`).
    static let appBasePath = "/app"

    // MARK: - URLs the app itself generates

    /// The URL that opens the review queue. Used by the notification, which
    /// cannot hold a view.
    static var reviewQueueURL: URL { url(for: .reviewQueue) }

    /// The app-scheme URL for a target — what notifications, widgets and
    /// Spotlight items carry. Round-trips through `parse`.
    static func url(for link: AppDeepLink) -> URL {
        let hostAndPath: String
        switch link {
        case .reviewQueue: hostAndPath = "review-queue"
        case .album(let id): hostAndPath = "album/\(id)"
        case .sharedAlbum(let token): hostAndPath = "shared-album/\(token)"
        case .photo(let id): hostAndPath = "photo/\(id)"
        case .person(let id): hostAndPath = "person/\(id)"
        case .recap(let id): hostAndPath = "recap/\(id)"
        case .recaps: hostAndPath = "recaps"
        case .feed: hostAndPath = "feed"
        case .search(let query):
            var components = URLComponents()
            components.scheme = scheme
            components.host = "search"
            components.queryItems = [URLQueryItem(name: "q", value: query)]
            return components.url!
        }
        return URL(string: "\(scheme)://\(hostAndPath)")!
    }

    /// The web URL for a target on the given server — what Handoff and
    /// „im Browser öffnen" use. `nil` when there is no server configured.
    static func webURL(for link: AppDeepLink, serverURL: URL?) -> URL? {
        guard let serverURL else { return nil }
        if case .search = link { return nil }
        let origin = serverURL.absoluteString
            .replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        let path: String
        switch link {
        case .reviewQueue: path = "/fotos/review-queue"
        case .album(let id): path = "/fotos/alben/\(id)"
        case .sharedAlbum(let token): path = "/albums/shared/\(token)"
        case .photo(let id): path = "/fotos/galerie?photoId=\(id)"
        case .person(let id): path = "/fotos/personen?personId=\(id)"
        case .recap(let id): path = "/fotos/rueckblicke?recapId=\(id)"
        case .recaps: path = "/fotos/rueckblicke"
        case .feed: path = "/fotos/feed"
        case .search: return nil
        }
        return URL(string: "\(origin)\(appBasePath)\(path)")
    }

    // MARK: - Parsing

    /// Read a URL the system handed us.
    ///
    /// - Parameter serverURL: the configured API server. A `https` URL is
    ///   only accepted when its host is this server's host — the app must not
    ///   act on a link to some other site that happens to share the path
    ///   layout. `nil` rejects every web URL.
    ///
    /// An unknown shape returns `nil`: the app then opens on whatever it was
    /// showing rather than somewhere arbitrary.
    static func parse(_ url: URL, serverURL: URL? = nil) -> AppDeepLink? {
        guard let scheme = url.scheme?.lowercased() else { return nil }
        if scheme == Self.scheme {
            return parseAppScheme(url)
        }
        if scheme == "https" || scheme == "http" {
            return parseWebURL(url, serverURL: serverURL)
        }
        return nil
    }

    /// `f4milphotos://album/12`, `f4milphotos:/album/12` and
    /// `f4milphotos:album/12` all mean the same thing; accept all three rather
    /// than depending on how the link was typed or generated.
    private static func parseAppScheme(_ url: URL) -> AppDeepLink? {
        var raw = url.absoluteString.dropFirst("\(scheme):".count)
        var queryString: Substring?
        if let q = raw.firstIndex(of: "?") {
            queryString = raw[raw.index(after: q)...]
            raw = raw[..<q]
        }
        let segments = raw
            .split(separator: "/", omittingEmptySubsequences: true)
            .map { $0.removingPercentEncoding ?? String($0) }
        guard let head = segments.first?.lowercased() else { return nil }
        let arg = segments.count > 1 ? segments[1] : nil

        switch (head, arg) {
        case ("review-queue", nil): return .reviewQueue
        case ("recaps", nil): return .recaps
        case ("feed", nil): return .feed
        case ("search", nil):
            var components = URLComponents()
            components.percentEncodedQuery = queryString.map(String.init)
            let query = components.queryItems?.first { $0.name == "q" }?.value?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return query.isEmpty ? nil : .search(query: query)
        case ("album", let id?): return Int(id).map { .album(id: $0) }
        case ("photo", let id?): return Int(id).map { .photo(id: $0) }
        case ("person", let id?): return Int(id).map { .person(id: $0) }
        case ("recap", let id?): return Int(id).map { .recap(id: $0) }
        case ("shared-album", let token?): return validToken(token).map { .sharedAlbum(token: $0) }
        default: return nil
        }
    }

    /// The web app's routes (`frontend/src/router/index.ts`,
    /// `frontend/src/config/modules.ts`), including the legacy redirects the
    /// router still honours, so an old bookmark opens the same screen.
    private static func parseWebURL(_ url: URL, serverURL: URL?) -> AppDeepLink? {
        guard let serverHost = serverURL?.host?.lowercased(),
              url.host?.lowercased() == serverHost else { return nil }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }

        var path = components.path
        guard path.lowercased().hasPrefix(appBasePath) else { return nil }
        path = String(path.dropFirst(appBasePath.count))
        let segments = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        let query = Dictionary(
            (components.queryItems ?? []).compactMap { item in item.value.map { (item.name, $0) } },
            uniquingKeysWith: { first, _ in first }
        )
        func intQuery(_ name: String) -> Int? { query[name].flatMap(Int.init) }

        // Swift cannot pattern-match array literals with bindings, so the
        // route table is spelled out by segment count.
        let lower = segments.map { $0.lowercased() }
        let first = lower.count > 0 ? lower[0] : nil
        let second = lower.count > 1 ? lower[1] : nil
        let third = lower.count > 2 ? lower[2] : nil

        switch lower.count {
        case 1:
            // `/app/photos?photoId=` (legacy) and `/app/fotos?photoId=`: a bare
            // gallery link has no in-app target of its own; only a photo deep
            // link is worth leaving Safari for.
            guard first == "photos" || first == "fotos" else { return nil }
            return intQuery("photoId").map { .photo(id: $0) }
        case 2:
            switch (first, second) {
            case ("albums", let id?):
                return Int(id).map { .album(id: $0) }
            case ("fotos", "personen"):
                return intQuery("personId").map { .person(id: $0) }
            case ("fotos", "rueckblicke"):
                return intQuery("recapId").map { .recap(id: $0) } ?? .recaps
            case ("fotos", "feed"):
                return .feed
            case ("fotos", "review-queue"):
                return .reviewQueue
            case ("fotos", "galerie"):
                return intQuery("photoId").map { .photo(id: $0) }
            default:
                return nil
            }
        case 3:
            switch (first, second) {
            case ("fotos", "alben"):
                return third.flatMap(Int.init).map { .album(id: $0) }
            case ("albums", "shared"):
                // Case-preserved: the token is opaque.
                return validToken(segments[2]).map { .sharedAlbum(token: $0) }
            default:
                return nil
            }
        default:
            return nil
        }
    }

    /// Share tokens are URL-safe base64 (`photo/photo.ts`); anything else in
    /// that slot is not a link we generated.
    private static func validToken(_ token: String) -> String? {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_-"))
        guard !token.isEmpty, token.unicodeScalars.allSatisfy(allowed.contains) else { return nil }
        return token
    }
}
