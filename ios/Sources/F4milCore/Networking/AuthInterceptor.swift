import Foundation

/// Provides Bearer token injection for URLSession requests.
/// Used when integrating with the OpenAPI-generated client.
public struct AuthInterceptor {
    public let authManager: AuthManager

    public init(authManager: AuthManager) {
        self.authManager = authManager
    }

    public func intercept(_ request: inout URLRequest) {
        if let token = authManager.token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
    }
}
