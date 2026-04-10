import Foundation

actor APIClient {
    static let shared = APIClient()
    static let serverURLKey = "apiServerURL"

    // Default to localhost for development. Override via Admin → Server settings.
    var baseURL: URL

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        return d
    }()

    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        return e
    }()

    private var authManager: AuthManager?
    private var isRefreshing = false

    init() {
        if let stored = UserDefaults.standard.string(forKey: APIClient.serverURLKey),
           let url = URL(string: stored) {
            self.baseURL = url
        } else {
            self.baseURL = URL(string: "http://localhost:4000")!
        }
    }

    func setAuthManager(_ manager: AuthManager) {
        self.authManager = manager
    }

    func setBaseURL(_ url: URL) {
        self.baseURL = url
        UserDefaults.standard.set(url.absoluteString, forKey: APIClient.serverURLKey)
    }

    // MARK: - Generic Requests

    func get<T: Decodable>(_ path: String, query: [String: String]? = nil) async throws -> T {
        let url = buildURL(path: path, query: query)
        var request = URLRequest(url: url, timeoutInterval: 30)
        request.httpMethod = "GET"
        applyAuth(&request)
        return try await performWithRefresh(request)
    }

    func post<B: Encodable, T: Decodable>(_ path: String, body: B) async throws -> T {
        var request = URLRequest(url: buildURL(path: path), timeoutInterval: 30)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        applyAuth(&request)
        return try await performWithRefresh(request)
    }

    /// POST without automatic 401 retry — used by the refresh endpoint itself to avoid loops.
    func postWithoutRetry<B: Encodable, T: Decodable>(_ path: String, body: B) async throws -> T {
        var request = URLRequest(url: buildURL(path: path), timeoutInterval: 30)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        applyAuth(&request)
        return try await perform(request)
    }

    func put<B: Encodable, T: Decodable>(_ path: String, body: B) async throws -> T {
        var request = URLRequest(url: buildURL(path: path), timeoutInterval: 30)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        applyAuth(&request)
        return try await performWithRefresh(request)
    }

    func patch<B: Encodable, T: Decodable>(_ path: String, body: B) async throws -> T {
        var request = URLRequest(url: buildURL(path: path), timeoutInterval: 30)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        applyAuth(&request)
        return try await performWithRefresh(request)
    }

    func delete<T: Decodable>(_ path: String) async throws -> T {
        var request = URLRequest(url: buildURL(path: path), timeoutInterval: 30)
        request.httpMethod = "DELETE"
        applyAuth(&request)
        return try await performWithRefresh(request)
    }

    // MARK: - Raw Upload (matching web frontend pattern: raw body + X-File-Name header)

    func uploadPhoto(data: Data, filename: String, mimeType: String) async throws -> Photo {
        var request = URLRequest(url: buildURL(path: "/photos"))
        request.httpMethod = "POST"
        request.setValue(mimeType, forHTTPHeaderField: "Content-Type")
        request.setValue(filename, forHTTPHeaderField: "X-File-Name")
        request.httpBody = data
        applyAuth(&request)
        return try await performWithRefresh(request)
    }

    // MARK: - Download (for photos/thumbnails)

    func downloadData(_ path: String, query: [String: String]? = nil) async throws -> Data {
        let url = buildURL(path: path, query: query)
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        applyAuth(&request)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }

        if httpResponse.statusCode == 401 {
            // Try refresh
            if let manager = authManager, await manager.tryRefresh() {
                applyAuth(&request)
                let (retryData, retryResponse) = try await URLSession.shared.data(for: request)
                guard let retryHttp = retryResponse as? HTTPURLResponse else {
                    throw APIError.invalidResponse
                }
                guard (200...299).contains(retryHttp.statusCode) else {
                    authManager?.handleUnauthorized()
                    throw APIError.httpError(retryHttp.statusCode, parseErrorMessage(retryData))
                }
                return retryData
            }
            authManager?.handleUnauthorized()
            throw APIError.httpError(401, parseErrorMessage(data))
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            throw APIError.httpError(httpResponse.statusCode, parseErrorMessage(data))
        }
        return data
    }

    // MARK: - Private

    private func buildURL(path: String, query: [String: String]? = nil) -> URL {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if let query {
            components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        return components.url!
    }

    private func applyAuth(_ request: inout URLRequest) {
        // Fall back to reading the token directly from the Keychain if the authManager
        // hasn't been injected yet (avoids a race with the .task that sets it on app start).
        let token = authManager?.token ?? KeychainHelper.loadString(forKey: "auth_token")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
    }

    private func perform<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            if httpResponse.statusCode == 401 {
                authManager?.handleUnauthorized()
            }
            throw APIError.httpError(httpResponse.statusCode, parseErrorMessage(data))
        }

        return try decoder.decode(T.self, from: data)
    }

    /// Performs request; on 401, attempts a token refresh and retries once.
    private func performWithRefresh<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }

        if httpResponse.statusCode == 401, let manager = authManager {
            let refreshed = await manager.tryRefresh()
            if refreshed {
                var retryRequest = request
                applyAuth(&retryRequest)
                return try await perform(retryRequest)
            }
            manager.handleUnauthorized()
            throw APIError.httpError(401, parseErrorMessage(data))
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            throw APIError.httpError(httpResponse.statusCode, parseErrorMessage(data))
        }

        return try decoder.decode(T.self, from: data)
    }

    private func parseErrorMessage(_ data: Data) -> String {
        if let errorBody = try? JSONDecoder().decode(APIErrorBody.self, from: data) {
            return errorBody.message
        }
        return String(data: data, encoding: .utf8) ?? "Unknown error"
    }
}

// MARK: - Error Types

enum APIError: Error, LocalizedError {
    case invalidResponse
    case httpError(Int, String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Invalid server response"
        case .httpError(let code, let message):
            return "HTTP \(code): \(message)"
        }
    }
}

private struct APIErrorBody: Decodable {
    let code: String?
    let message: String
}
