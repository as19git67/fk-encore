import Foundation

/// Opening a web page signed in as the app's user
/// (documentation/plans/assistent-ios.md, stage 5).
///
/// The web app keeps its own session and knows nothing of the app's, and the
/// bearer token must not travel in a URL. So the app asks the server for a
/// handover token — random, good for a minute, usable once — and opens the
/// web app's `/handover` page with it. Token and target page ride in the URL
/// *fragment*: a fragment never leaves the browser, so neither appears in the
/// server's access log. The page redeems the token for an ordinary web
/// session and goes on to the target.
///
/// Lives in the core so every app's web view can use it, not only the
/// assistant's.
public enum WebHandover {
    public struct Token: Decodable, Sendable {
        public let token: String
        /// ISO-8601; the page must be opened before this.
        public let expiresAt: String
    }

    /// Path of the page under the web app's base path (`AppDeepLink.appBasePath`).
    public static let pagePath = "/handover"

    /// Asks the server for a one-time token. Throws what `APIClient` throws.
    public static func requestToken(client: APIClient = .shared) async throws -> Token {
        try await client.post("/auth/handover", body: EmptyBody())
    }

    /// `https://<server>/app/handover#token=<token>&redirect=<route>` —
    /// pure, so the shape is testable. `route` is the web path inside the
    /// app (`/finanzen/umsaetze/9?q=miete`), with or without its leading
    /// slash. Nil only when the server URL is not a usable origin.
    public static func url(serverURL: URL, route: String, token: String) -> URL? {
        let origin = serverURL.absoluteString
            .replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        guard var components = URLComponents(string: origin + AppDeepLink.appBasePath + pagePath) else { return nil }
        let redirect = route.hasPrefix("/") ? route : "/" + route
        var fragment = URLComponents()
        fragment.queryItems = [
            URLQueryItem(name: "token", value: token),
            URLQueryItem(name: "redirect", value: redirect),
        ]
        // `percentEncodedQuery` leaves `?` and `/` alone, which the page
        // reads back as they are; `&` and `#` inside the redirect are encoded.
        // A literal `+` is encoded by hand: the page reads the fragment with
        // `URLSearchParams`, which would turn it into a space.
        components.percentEncodedFragment = fragment.percentEncodedQuery?
            .replacingOccurrences(of: "+", with: "%2B")
        return components.url
    }

    /// The signed-in URL for `route`, or nil when the server refused or could
    /// not be reached — the caller then opens the plain page, which asks for
    /// a login once.
    public static func signedInURL(for route: String, client: APIClient = .shared) async -> URL? {
        guard let issued = try? await requestToken(client: client) else { return nil }
        return url(serverURL: await client.baseURL, route: route, token: issued.token)
    }

    private struct EmptyBody: Encodable {}
}
