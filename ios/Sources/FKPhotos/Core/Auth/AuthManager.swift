import Foundation
import SwiftUI

@Observable
public final class AuthManager: @unchecked Sendable {
    private(set) var currentUser: UserWithRolesAndPermissions?
    private(set) var isAuthenticated = false
    private(set) var isLoading = false

    private let tokenKey = "auth_token"
    private let refreshTokenKey = "refresh_token"
    private let userKey = "auth_user"
    static let savedEmailKey = "saved_login_email"

    var token: String? {
        KeychainHelper.loadString(forKey: tokenKey)
    }

    var refreshToken: String? {
        KeychainHelper.loadString(forKey: refreshTokenKey)
    }

    public init() {
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

        try saveTokens(accessToken: response.token, refreshToken: response.refreshToken, user: response.user)
        UserDefaults.standard.set(email, forKey: AuthManager.savedEmailKey)
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
            return false
        }

        do {
            let body = RefreshRequest(refreshToken: rt)
            let response: RefreshResponse = try await APIClient.shared.postWithoutRetry("/auth/refresh", body: body)
            try saveTokens(accessToken: response.token, refreshToken: response.refreshToken, user: response.user)
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

    private func saveTokens(accessToken: String, refreshToken: String, user: UserWithRolesAndPermissions) throws {
        try KeychainHelper.saveString(accessToken, forKey: tokenKey)
        try KeychainHelper.saveString(refreshToken, forKey: refreshTokenKey)
        let userData = try JSONEncoder().encode(user)
        try KeychainHelper.save(userData, forKey: userKey)

        // Mirror both tokens to the App Group so the Share Extension can
        // authenticate and refresh the access token on its own.
        SharedStorage.defaults.set(accessToken, forKey: SharedStorage.tokenKey)
        SharedStorage.defaults.set(refreshToken, forKey: SharedStorage.refreshTokenKey)

        Task { @MainActor in
            currentUser = user
            isAuthenticated = true
        }
    }

    private func clearSession() {
        KeychainHelper.delete(forKey: tokenKey)
        KeychainHelper.delete(forKey: refreshTokenKey)
        KeychainHelper.delete(forKey: userKey)
        SharedStorage.defaults.removeObject(forKey: SharedStorage.tokenKey)
        SharedStorage.defaults.removeObject(forKey: SharedStorage.refreshTokenKey)
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
}
