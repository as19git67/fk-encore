import Foundation

/// Builds the shareable URL for an album's public link.
///
/// The token can be reached through two entirely different paths, and only one
/// of them is meant for a human recipient:
///
/// - `/albums/public/<token>` is the **API** endpoint (`photo/photo.ts`,
///   `getPublicAlbum`). It answers with raw JSON.
/// - `/app/albums/shared/<token>` is the **SPA route** the web app links to
///   (`frontend/src/router/index.ts`, served under Vite's `/app/` base by
///   `web/static.ts`). That handler additionally injects Open Graph meta tags
///   for the album, which is what gives iMessage and social previews a title
///   and cover image instead of a bare link.
///
/// Sharing the API path sends recipients a JSON document, so the SPA route is
/// the only correct choice here. `web/static.ts` builds the same string
/// server-side as its canonical `pageUrl`.
enum AlbumPublicLinkURL {

    /// Path prefix the frontend is served under — Vite's `base` in
    /// `frontend/vite.config.ts`, matched by the `/app/*path` raw endpoint.
    static let appBasePath = "/app"

    /// - Parameters:
    ///   - serverURL: the configured API server origin, e.g.
    ///     `https://f4mil.example`. A trailing slash is tolerated.
    ///   - token: the public link token.
    /// - Returns: the shareable SPA URL, or `nil` if `serverURL` is blank or
    ///   `token` is empty — there is no meaningful link to hand out then.
    static func make(serverURL: String, token: String) -> String? {
        let origin = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
            // A server URL stored with a trailing slash would otherwise produce
            // a double slash before the app base path.
            .replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        guard !origin.isEmpty, !token.isEmpty else { return nil }
        return "\(origin)\(appBasePath)/albums/shared/\(token)"
    }
}
