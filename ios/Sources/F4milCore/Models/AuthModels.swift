import Foundation

// The wire types of the session: who is signed in and what the login and
// refresh endpoints answer. They live here, not in the app's model file,
// because `AuthManager` and `APIClient` are what every app shares, and a
// public type cannot be built from an internal one. The memberwise inits are
// spelled out: a public struct does not get one for free, and the tests build
// these by hand.

public struct Role: Codable, Identifiable, Sendable {
    public let id: Int
    public let name: String
    public let description: String

    public init(id: Int, name: String, description: String) {
        self.id = id
        self.name = name
        self.description = description
    }
}

public struct UserWithRolesAndPermissions: Codable, Identifiable, Sendable {
    public let id: Int
    public let email: String
    public let name: String
    public let created_at: String
    public let updated_at: String
    public let roles: [Role]
    public let permissions: [String]

    public init(id: Int, email: String, name: String, created_at: String, updated_at: String, roles: [Role], permissions: [String]) {
        self.id = id
        self.email = email
        self.name = name
        self.created_at = created_at
        self.updated_at = updated_at
        self.roles = roles
        self.permissions = permissions
    }
}

public struct LoginRequest: Codable, Sendable {
    public let email: String
    public let password: String

    public init(email: String, password: String) {
        self.email = email
        self.password = password
    }
}

public struct LoginResponse: Codable, Sendable {
    public let user: UserWithRolesAndPermissions
    public let token: String
    public let refreshToken: String
    /// ISO-8601 instant the access token expires. Optional so decoding still
    /// succeeds against an older server that doesn't send it yet.
    public let expiresAt: String?

    public init(user: UserWithRolesAndPermissions, token: String, refreshToken: String, expiresAt: String?) {
        self.user = user
        self.token = token
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
    }
}

public struct SuccessResponse: Codable, Sendable {
    public let success: Bool
    public let message: String

    public init(success: Bool, message: String) {
        self.success = success
        self.message = message
    }
}
