import Foundation

/// The share extension's half of the session (§ iOS auth).
///
/// The extension cannot reach the app's Keychain, so the app mirrors the
/// token pair and the server URL into the App Group and the extension
/// reads them from there. What was missing is what happens **fifteen
/// minutes later**: an access token lives that long, and the trip half
/// of the extension had no way to renew one. Sharing a spot after
/// lunch therefore failed with "F4mil ist nicht eingerichtet" until
/// somebody signed out and in again — for a session that was perfectly
/// valid, only asleep.
///
/// So both halves of the extension now go through here, and there is
/// one implementation of the two rules that matter:
///
///   - **Refresh before asking**, when the stored expiry says the token
///     is about to run out. Cheaper than a round trip that is going to
///     come back 401.
///   - **Refresh once on a 401**, and repeat the request. The expiry is
///     only as good as the last write; a token can be gone early
///     (a server restart, a password change elsewhere).
///
/// The rotated pair is written back to the App Group, expiry included,
/// so the main app picks it up rather than reaching for the older one
/// it still has in its Keychain.
enum ShareAuth {
    static let appGroupID = "group.de.f4mil.photos"

    enum Key {
        static let token = "shared.auth_token"
        static let refreshToken = "shared.refresh_token"
        static let expiry = "shared.auth_token_expiry"
        static let serverURL = "shared.serverURL"
    }

    /// Refresh this long before the expiry rather than after it: the
    /// two minutes are the app's own margin (`APIClient.ensureFreshToken`),
    /// and one number for both keeps them from disagreeing about
    /// whether a session is still good.
    static let refreshMargin: TimeInterval = 120

    static var defaults: UserDefaults? { UserDefaults(suiteName: appGroupID) }

    static var token: String? {
        let value = defaults?.string(forKey: Key.token)
        return (value?.isEmpty == false) ? value : nil
    }

    static var refreshToken: String? {
        let value = defaults?.string(forKey: Key.refreshToken)
        return (value?.isEmpty == false) ? value : nil
    }

    static var serverURL: URL? {
        guard let stored = defaults?.string(forKey: Key.serverURL), !stored.isEmpty else {
            return nil
        }
        return URL(string: stored)
    }

    /// When the access token runs out, as the server reported it. Nil
    /// when nobody has written one yet — an older app, or a session
    /// that predates the field.
    static var expiry: Date? {
        let epoch = defaults?.double(forKey: Key.expiry) ?? 0
        return epoch > 0 ? Date(timeIntervalSince1970: epoch) : nil
    }

    /// Is the stored token worth sending?
    ///
    /// An unknown expiry counts as fresh: refreshing on every share
    /// because a field is missing would rotate the pair constantly, and
    /// every rotation is a chance to lose the new one when the
    /// extension is killed mid-flight. The 401 path catches that case
    /// instead.
    static func isFresh(at now: Date = Date()) -> Bool {
        guard token != nil else { return false }
        guard let expiry else { return true }
        return expiry.timeIntervalSince(now) > refreshMargin
    }

    /// Perform a request, renewing the session around it when needed.
    ///
    /// The request is **rebuilt** for the retry rather than reused: it
    /// has to pick up the new token, and a body stream can only be read
    /// once.
    static func perform(_ build: () throws -> URLRequest) async throws -> (Data, HTTPURLResponse) {
        if !isFresh() { _ = await refresh() }

        let (data, response) = try await URLSession.shared.data(for: build())
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard http.statusCode == 401 else { return (data, http) }

        guard await refresh() else { return (data, http) }
        let (retryData, retryResponse) = try await URLSession.shared.data(for: build())
        guard let retryHttp = retryResponse as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return (retryData, retryHttp)
    }

    /// Exchange the refresh token for a new pair and write it back.
    ///
    /// Answers false when there is nothing to refresh with or the
    /// server refused — then, and only then, is a fresh login the
    /// honest answer.
    @discardableResult
    static func refresh() async -> Bool {
        guard let base = serverURL, let refreshToken else { return false }

        var request = URLRequest(url: base.appendingPathComponent("/auth/refresh"),
                                 timeoutInterval: 30)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        struct Body: Encodable { let refreshToken: String }
        struct TokenResponse: Decodable {
            let token: String
            let refreshToken: String
            /// ISO 8601, when the server says so. Older servers do not.
            let expiresAt: String?
        }
        guard let body = try? JSONEncoder().encode(Body(refreshToken: refreshToken)) else {
            return false
        }
        request.httpBody = body

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse,
              (200...299).contains(http.statusCode),
              let decoded = try? JSONDecoder().decode(TokenResponse.self, from: data)
        else {
            // Two ways to get here that are not the same thing: the
            // refresh token really is dead (30 days, or a logout
            // elsewhere), or the server was unreachable. Neither is
            // worth throwing over — the caller reports the request that
            // failed, and the next share tries again.
            return false
        }

        defaults?.set(decoded.token, forKey: Key.token)
        defaults?.set(decoded.refreshToken, forKey: Key.refreshToken)
        // The expiry travels with the pair: without it the app and the
        // extension both fall back to "assume fresh" and meet the 401
        // the hard way.
        if let expiresAt = decoded.expiresAt, let date = parseISO(expiresAt) {
            defaults?.set(date.timeIntervalSince1970, forKey: Key.expiry)
        } else {
            defaults?.removeObject(forKey: Key.expiry)
        }
        return true
    }

    /// Parses a server timestamp with or without fractional seconds.
    /// `Date.toISOString()` emits milliseconds; being lenient costs
    /// nothing and a wrong "expired" reading costs a share.
    private static func parseISO(_ iso: String) -> Date? {
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFractional.date(from: iso) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: iso)
    }
}
