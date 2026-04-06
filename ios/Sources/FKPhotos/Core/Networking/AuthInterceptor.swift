import Foundation

/// Provides Bearer token injection for URLSession requests.
/// Used when integrating with the OpenAPI-generated client.
struct AuthInterceptor {
    let authManager: AuthManager

    func intercept(_ request: inout URLRequest) {
        if let token = authManager.token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
    }
}
