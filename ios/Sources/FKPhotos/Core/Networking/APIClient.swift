import Foundation

actor APIClient {
    static let shared = APIClient()

    // Default to localhost for development. Override via Settings or environment.
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

    init(baseURL: URL = URL(string: "http://localhost:4000")!) {
        self.baseURL = baseURL
    }

    func setAuthManager(_ manager: AuthManager) {
        self.authManager = manager
    }

    func setBaseURL(_ url: URL) {
        self.baseURL = url
    }

    // MARK: - Generic Requests

    func get<T: Decodable>(_ path: String, query: [String: String]? = nil) async throws -> T {
        let url = buildURL(path: path, query: query)
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        applyAuth(&request)
        return try await perform(request)
    }

    func post<B: Encodable, T: Decodable>(_ path: String, body: B) async throws -> T {
        var request = URLRequest(url: buildURL(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        applyAuth(&request)
        return try await perform(request)
    }

    func put<B: Encodable, T: Decodable>(_ path: String, body: B) async throws -> T {
        var request = URLRequest(url: buildURL(path: path))
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        applyAuth(&request)
        return try await perform(request)
    }

    func delete<T: Decodable>(_ path: String) async throws -> T {
        var request = URLRequest(url: buildURL(path: path))
        request.httpMethod = "DELETE"
        applyAuth(&request)
        return try await perform(request)
    }

    // MARK: - Raw Upload (matching web frontend pattern: raw body + X-File-Name header)

    func uploadPhoto(data: Data, filename: String, mimeType: String) async throws -> Photo {
        var request = URLRequest(url: buildURL(path: "/photos"))
        request.httpMethod = "POST"
        request.setValue(mimeType, forHTTPHeaderField: "Content-Type")
        request.setValue(filename, forHTTPHeaderField: "X-File-Name")
        request.httpBody = data
        applyAuth(&request)
        return try await perform(request)
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
        guard (200...299).contains(httpResponse.statusCode) else {
            if httpResponse.statusCode == 401 {
                authManager?.handleUnauthorized()
            }
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
        if let token = authManager?.token {
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
