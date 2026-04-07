import Foundation
import SwiftUI

@Observable
public final class AuthManager: @unchecked Sendable {
    private(set) var currentUser: UserWithRolesAndPermissions?
    private(set) var isAuthenticated = false
    private(set) var isLoading = false

    private let tokenKey = "auth_token"
    private let userKey = "auth_user"

    var token: String? {
        KeychainHelper.loadString(forKey: tokenKey)
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

        try KeychainHelper.saveString(response.token, forKey: tokenKey)
        let userData = try JSONEncoder().encode(response.user)
        try KeychainHelper.save(userData, forKey: userKey)

        currentUser = response.user
        isAuthenticated = true
    }

    @MainActor
    func logout() async {
        // Try server-side logout, but don't block on failure
        try? await APIClient.shared.post("/auth/logout", body: Empty()) as SuccessResponse

        KeychainHelper.delete(forKey: tokenKey)
        KeychainHelper.delete(forKey: userKey)
        currentUser = nil
        isAuthenticated = false
    }

    func hasPermission(_ permission: String) -> Bool {
        currentUser?.permissions.contains(permission) ?? false
    }

    func handleUnauthorized() {
        KeychainHelper.delete(forKey: tokenKey)
        KeychainHelper.delete(forKey: userKey)
        Task { @MainActor in
            currentUser = nil
            isAuthenticated = false
        }
    }
}

private struct Empty: Codable {}
