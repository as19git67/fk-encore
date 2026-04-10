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
        _ = token // Token exists and is valid in keychain
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
        guard let rt = KeychainHelper.loadString(forKey: refreshTokenKey), !rt.isEmpty else {
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

        Task { @MainActor in
            currentUser = user
            isAuthenticated = true
        }
    }

    private func clearSession() {
        KeychainHelper.delete(forKey: tokenKey)
        KeychainHelper.delete(forKey: refreshTokenKey)
        KeychainHelper.delete(forKey: userKey)
        UserDefaults.standard.removeObject(forKey: AuthManager.savedEmailKey)
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
