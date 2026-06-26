import Foundation
import Security
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

@Observable
public final class AuthManager: @unchecked Sendable {
    private(set) var currentUser: UserWithRolesAndPermissions?
    private(set) var isAuthenticated = false
    private(set) var isLoading = false

    private let tokenKey = "auth_token"
    private let refreshTokenKey = "refresh_token"
    private let userKey = "auth_user"
    private let passwordKey = "saved_login_password"
    static let savedEmailKey = "saved_login_email"

    var token: String? {
        KeychainHelper.loadString(forKey: tokenKey)
    }

    var refreshToken: String? {
        KeychainHelper.loadString(forKey: refreshTokenKey)
    }

    /// When the current access token expires, as reported by the server at
    /// login/refresh. `nil` when unknown (older server, or not yet refreshed
    /// since the app was updated). Stored in the App Group so the APIClient and
    /// the Share Extension share the same view.
    var accessTokenExpiry: Date? {
        let epoch = SharedStorage.defaults.double(forKey: SharedStorage.tokenExpiryKey)
        return epoch > 0 ? Date(timeIntervalSince1970: epoch) : nil
    }

    public init() {
        restoreSession()
        #if canImport(UIKit)
        // The first `restoreSession()` can run while the device is still locked
        // — e.g. the app was launched in the background for a sync, or right
        // after a reboot before the first unlock. The Keychain items are stored
        // with `kSecAttrAccessibleAfterFirstUnlock`, so they're unreadable then
        // and the user would be shown the login screen even though a valid
        // session exists. Re-attempt the restore once the device is unlocked.
        NotificationCenter.default.addObserver(
            forName: UIApplication.protectedDataDidBecomeAvailableNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.retryRestoreIfNeeded()
        }
        #endif
    }

    /// Re-attempt session restore when we're not currently authenticated. Safe
    /// to call repeatedly: it no-ops once a session is restored. Invoked when
    /// protected data becomes available and when the app returns to the
    /// foreground, so unlocking the iPhone always regains access to the stored
    /// token instead of prompting for the password again.
    func retryRestoreIfNeeded() {
        guard !isAuthenticated else { return }
        restoreSession()
    }

    private func restoreSession() {
        guard let token = KeychainHelper.loadString(forKey: tokenKey),
              !token.isEmpty,
              let userData = KeychainHelper.load(forKey: userKey),
              let user = try? JSONDecoder().decode(UserWithRolesAndPermissions.self, from: userData)
        else {
            isAuthenticated = false
            currentUser = nil
            return
        }
        // Mirror the tokens to the App Group so the Share Extension works
        // immediately — and can refresh on its own — without a fresh login.
        SharedStorage.defaults.set(token, forKey: SharedStorage.tokenKey)
        if let rt = KeychainHelper.loadString(forKey: refreshTokenKey), !rt.isEmpty {
            SharedStorage.defaults.set(rt, forKey: SharedStorage.refreshTokenKey)
        }
        currentUser = user
        isAuthenticated = true
    }

    @MainActor
    func login(email: String, password: String) async throws {
        isLoading = true
        defer { isLoading = false }

        let request = LoginRequest(email: email, password: password)
        let response: LoginResponse = try await APIClient.shared.post("/auth/login", body: request)

        try saveTokens(
            accessToken: response.token,
            refreshToken: response.refreshToken,
            user: response.user,
            expiresAt: response.expiresAt
        )
        UserDefaults.standard.set(email, forKey: AuthManager.savedEmailKey)
        // Persist the password in the Keychain (device-only) so the app can
        // silently re-authenticate when both tokens are gone — avoids a visible
        // logout after long background gaps. Cleared on explicit logout.
        try? KeychainHelper.saveString(
            password,
            forKey: passwordKey,
            accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        )
    }

    @MainActor
    func logout() async {
        // Try server-side logout, but don't block on failure
        let body = LogoutRequest(refreshToken: refreshToken)
        try? await APIClient.shared.post("/auth/logout", body: body) as SuccessResponse

        clearSession()
    }

    /// Attempt to refresh the access token using the stored refresh token.
    /// Returns `true` if the refresh succeeded.
    func tryRefresh() async -> Bool {
        // Prefer the App Group copy: the Share Extension may have rotated the
        // refresh token. Fall back to the Keychain (first run after update).
        let rt = SharedStorage.defaults.string(forKey: SharedStorage.refreshTokenKey)
            ?? KeychainHelper.loadString(forKey: refreshTokenKey)
        guard let rt, !rt.isEmpty else {
            return await silentRelogin()
        }

        do {
            let body = RefreshRequest(refreshToken: rt)
            let response: RefreshResponse = try await APIClient.shared.postWithoutRetry("/auth/refresh", body: body)
            try saveTokens(
                accessToken: response.token,
                refreshToken: response.refreshToken,
                user: response.user,
                expiresAt: response.expiresAt
            )
            return true
        } catch {
            // Refresh token rejected (rotated-away or expired). Fall back to a
            // silent re-login with the stored credentials before giving up.
            return await silentRelogin()
        }
    }

    /// Last-resort re-authentication: when the refresh token is missing or
    /// rejected, use the email + password persisted in the Keychain to log in
    /// again without showing the login screen. Returns `false` when no stored
    /// credentials exist (user logged in before this feature or via passkey).
    private func silentRelogin() async -> Bool {
        guard let email = UserDefaults.standard.string(forKey: AuthManager.savedEmailKey),
              !email.isEmpty,
              let password = KeychainHelper.loadString(forKey: passwordKey),
              !password.isEmpty
        else {
            return false
        }

        do {
            let request = LoginRequest(email: email, password: password)
            let response: LoginResponse = try await APIClient.shared.postWithoutRetry("/auth/login", body: request)
            try saveTokens(
                accessToken: response.token,
                refreshToken: response.refreshToken,
                user: response.user,
                expiresAt: response.expiresAt
            )
            return true
        } catch {
            return false
        }
    }

    func hasPermission(_ permission: String) -> Bool {
        currentUser?.permissions.contains(permission) ?? false
    }

    func handleUnauthorized() {
        clearSession()
    }

    // MARK: - Private

    private func saveTokens(
        accessToken: String,
        refreshToken: String,
        user: UserWithRolesAndPermissions,
        expiresAt: String?
    ) throws {
        try KeychainHelper.saveString(accessToken, forKey: tokenKey)
        try KeychainHelper.saveString(refreshToken, forKey: refreshTokenKey)
        let userData = try JSONEncoder().encode(user)
        try KeychainHelper.save(userData, forKey: userKey)

        // Mirror both tokens to the App Group so the Share Extension can
        // authenticate and refresh the access token on its own.
        SharedStorage.defaults.set(accessToken, forKey: SharedStorage.tokenKey)
        SharedStorage.defaults.set(refreshToken, forKey: SharedStorage.refreshTokenKey)
        Self.storeAccessTokenExpiry(expiresAt)

        Task { @MainActor in
            currentUser = user
            isAuthenticated = true
        }
    }

    /// Persists the access-token expiry (ISO-8601 string) as epoch seconds in
    /// the App Group, or clears it when `nil`/unparseable.
    private static func storeAccessTokenExpiry(_ iso: String?) {
        guard let iso, let date = parseISO(iso) else {
            SharedStorage.defaults.removeObject(forKey: SharedStorage.tokenExpiryKey)
            return
        }
        SharedStorage.defaults.set(date.timeIntervalSince1970, forKey: SharedStorage.tokenExpiryKey)
    }

    /// Parses a server ISO-8601 timestamp, with or without fractional seconds
    /// (`Date.toISOString()` emits milliseconds, but be lenient just in case).
    private static func parseISO(_ iso: String) -> Date? {
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFractional.date(from: iso) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: iso)
    }

    private func clearSession() {
        KeychainHelper.delete(forKey: tokenKey)
        KeychainHelper.delete(forKey: refreshTokenKey)
        KeychainHelper.delete(forKey: userKey)
        KeychainHelper.delete(forKey: passwordKey)
        SharedStorage.defaults.removeObject(forKey: SharedStorage.tokenKey)
        SharedStorage.defaults.removeObject(forKey: SharedStorage.refreshTokenKey)
        SharedStorage.defaults.removeObject(forKey: SharedStorage.tokenExpiryKey)
        Task { @MainActor in
            currentUser = nil
            isAuthenticated = false
        }
    }
}

private struct LogoutRequest: Codable {
    let refreshToken: String?
}

private struct RefreshRequest: Codable {
    let refreshToken: String
}

private struct RefreshResponse: Codable {
    let token: String
    let refreshToken: String
    let user: UserWithRolesAndPermissions
    /// Optional so decoding still succeeds against an older server. See LoginResponse.
    let expiresAt: String?
}
