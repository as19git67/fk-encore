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
    private var pendingRefreshContinuations: [CheckedContinuation<Bool, Never>] = []

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

    func uploadPhoto(data: Data, filename: String, mimeType: String, isFavorite: Bool = false, capturedAt: Date? = nil) async throws -> Photo {
        var request = URLRequest(url: buildURL(path: "/photos"))
        request.httpMethod = "POST"
        request.setValue(mimeType, forHTTPHeaderField: "Content-Type")
        request.setValue(filename, forHTTPHeaderField: "X-File-Name")
        if isFavorite {
            request.setValue("true", forHTTPHeaderField: "X-Is-Favorite")
        }
        // PHImageManager-rendered HEIC/JPEG often loses EXIF DateTimeOriginal,
        // so we forward PHAsset.creationDate. The server uses it only when
        // the file itself carries no capture timestamp.
        if let capturedAt {
            request.setValue(Self.iso8601Formatter.string(from: capturedAt), forHTTPHeaderField: "X-Captured-At")
        }
        request.httpBody = data
        applyAuth(&request)

        // Custom request flow because we need to surface the existing photo's
        // id from a 409 response so callers can still attach it to a target
        // album. Mirrors performWithRefresh' 401 → refresh → retry behavior.
        var (responseData, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401, let manager = authManager {
            let refreshed = await refreshOnce(manager: manager)
            if refreshed {
                applyAuth(&request)
                (responseData, response) = try await URLSession.shared.data(for: request)
            } else {
                manager.handleUnauthorized()
                throw APIError.httpError(401, parseErrorMessage(responseData))
            }
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        if http.statusCode == 409 {
            let photoId = (try? JSONDecoder().decode(DuplicatePhotoBody.self, from: responseData))?.photoId
            throw APIError.duplicatePhoto(photoId: photoId)
        }
        guard (200...299).contains(http.statusCode) else {
            if http.statusCode == 401 { authManager?.handleUnauthorized() }
            throw APIError.httpError(http.statusCode, parseErrorMessage(responseData))
        }
        return try decoder.decode(Photo.self, from: responseData)
    }

    private struct DuplicatePhotoBody: Decodable {
        let photoId: Int?
    }

    private static let iso8601Formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

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
            if let manager = authManager, await refreshOnce(manager: manager) {
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
    /// Concurrent 401s all wait for a single refresh to avoid token rotation conflicts.
    private func performWithRefresh<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }

        if httpResponse.statusCode == 401, let manager = authManager {
            let refreshed = await refreshOnce(manager: manager)
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

    /// Ensures only one refresh runs at a time. Subsequent callers wait for the first to finish.
    private func refreshOnce(manager: AuthManager) async -> Bool {
        if isRefreshing {
            return await withCheckedContinuation { continuation in
                pendingRefreshContinuations.append(continuation)
            }
        }

        isRefreshing = true
        let result = await manager.tryRefresh()
        isRefreshing = false

        let waiting = pendingRefreshContinuations
        pendingRefreshContinuations.removeAll()
        for continuation in waiting {
            continuation.resume(returning: result)
        }

        return result
    }

    private func parseErrorMessage(_ data: Data) -> String? {
        // Try JSON error body first (Encore error format)
        if let errorBody = try? JSONDecoder().decode(APIErrorBody.self, from: data) {
            return errorBody.message
        }
        // Ignore HTML responses (e.g. nginx 502 pages) — caller uses status code instead
        let text = String(data: data, encoding: .utf8) ?? ""
        if text.trimmingCharacters(in: .whitespaces).hasPrefix("<") { return nil }
        return text.isEmpty ? nil : text
    }
}

// MARK: - Error Types

enum APIError: Error, LocalizedError {
    case invalidResponse
    case httpError(Int, String?)
    /// Raised by `uploadPhoto` when the server detected a content-hash duplicate.
    /// Carries the existing photo's id so callers can still operate on it
    /// (e.g. add to an album). `nil` when the server did not include an id.
    case duplicatePhoto(photoId: Int?)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Ungültige Server-Antwort"
        case .duplicatePhoto:
            return "Foto wurde bereits hochgeladen."
        case .httpError(let code, let message):
            switch code {
            case 502, 503: return "Server nicht erreichbar (HTTP \(code))"
            case 504:      return "Server antwortet nicht – Zeitüberschreitung"
            case 401:      return "Nicht angemeldet"
            case 403:      return "Keine Berechtigung"
            case 404:      return "Nicht gefunden"
            case 500:      return message ?? "Interner Serverfehler"
            default:       return message ?? "HTTP \(code)"
            }
        }
    }
}

private struct APIErrorBody: Decodable {
    let code: String?
    let message: String
}
