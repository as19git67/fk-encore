import Foundation

actor APIClient {
    static let shared = APIClient()
    static let serverURLKey = "apiServerURL"

    // Default to localhost for development. Override via Admin → Server settings.
    var baseURL: URL

    /// The session every request runs through. Defaults to `.shared`;
    /// injectable so upload-contract tests can drive a `MockURLProtocol`
    /// session and assert exactly what the client sends to the server.
    private let session: URLSession

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

    init(session: URLSession = .shared) {
        self.session = session
        // Prefer the App Group suite (readable by the Share Extension) with a
        // migration fallback to the old standard UserDefaults location.
        let stored = SharedStorage.defaults.string(forKey: SharedStorage.serverURLKey)
            ?? UserDefaults.standard.string(forKey: APIClient.serverURLKey)
        if let stored, let url = URL(string: stored) {
            self.baseURL = url
        } else {
            self.baseURL = URL(string: "http://localhost:4000")!
        }
        // Always mirror the resolved URL to SharedStorage so the Share Extension
        // can read it even if setBaseURL() was never explicitly called.
        SharedStorage.defaults.set(self.baseURL.absoluteString, forKey: SharedStorage.serverURLKey)
    }

    func setAuthManager(_ manager: AuthManager) {
        self.authManager = manager
    }

    func setBaseURL(_ url: URL) {
        self.baseURL = url
        UserDefaults.standard.set(url.absoluteString, forKey: APIClient.serverURLKey)
        SharedStorage.defaults.set(url.absoluteString, forKey: SharedStorage.serverURLKey)
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

    // MARK: - Batch sync-check

    /// Asks the server which of the given full-hashes it already has.
    /// Returns the subset that exists server-side; everything NOT returned must be uploaded.
    func syncCheck(hashes: [String]) async throws -> Set<String> {
        struct Body: Encodable { let hashes: [String] }
        struct Response: Decodable { let existing: [String] }
        let response: Response = try await post("/photos/sync/check", body: Body(hashes: hashes))
        return Set(response.existing)
    }

    // MARK: - Metadata-only sync

    /// Result of a metadata-only sync call to POST /photos/sync/metadata.
    enum MetadataSyncResult {
        case updated(photoId: Int)
        case notFound
    }

    /// Sends a body-less metadata sync when only caption/favorite/date changed
    /// but the pixel data is identical. Returns `.notFound` when the server
    /// doesn't recognise the photo — caller should fall back to a full upload.
    func syncPhotoMetadata(
        imageDataHash: String,
        fullHash: String,
        caption: String,
        isFavorite: Bool,
        capturedAtString: String,
        assetLocalId: String
    ) async throws -> MetadataSyncResult {
        struct Body: Encodable {
            let imageDataHash: String
            let deviceAssetId: String
            let fullHash: String
            let description: String
            let isFavorite: Bool
            let capturedAt: String
        }
        struct Response: Decodable {
            let updated: Bool
            let photoId: Int
        }
        do {
            let response: Response = try await post("/photos/sync/metadata", body: Body(
                imageDataHash: imageDataHash,
                deviceAssetId: assetLocalId,
                fullHash: fullHash,
                description: caption,
                isFavorite: isFavorite,
                capturedAt: capturedAtString
            ))
            print("[MetadataSync] success, photoId=\(response.photoId)")
            return .updated(photoId: response.photoId)
        } catch let error as APIError {
            if case .httpError(404, _) = error {
                print("[MetadataSync] not found — falling back to full upload")
                return .notFound
            }
            throw error
        }
    }

    // MARK: - Raw Upload

    /// Result of a photo upload.
    /// - `created`: 201 — server stored a new photo record.
    /// - `updated`: 200 — server already had the photo (hash match); only metadata was updated.
    enum UploadResult {
        case created(Photo)
        case updated(photoId: Int)

        var photoId: Int {
            switch self {
            case .created(let p): return p.id
            case .updated(let id): return id
            }
        }
    }

    /// Uploads the raw image bytes to POST /photos using all headers required by the
    /// hash-based sync protocol. Never embeds caption or favorite into the file body —
    /// metadata travels exclusively as headers.
    ///
    /// - Returns `.created` (201) for a newly stored photo or `.updated` (200) when the
    ///   server already had this full-hash and only updated metadata.
    /// - Throws `APIError.duplicatePhoto` on 409.
    func uploadPhoto(
        data: Data,
        filename: String,
        mimeType: String,
        imageDataHash: String,
        fullHash: String,
        caption: String,
        isFavorite: Bool,
        capturedAtString: String,
        assetLocalId: String,
        latitude: Double? = nil,
        longitude: Double? = nil
    ) async throws -> UploadResult {
        var request = URLRequest(url: buildURL(path: "/photos"), timeoutInterval: 120)
        request.httpMethod = "POST"
        request.allowsCellularAccess = !PhotoSyncPreferences.wifiOnly
        request.setValue(mimeType, forHTTPHeaderField: "Content-Type")
        request.setValue(percentEncodeHeaderValue(filename), forHTTPHeaderField: "X-File-Name")
        request.setValue(imageDataHash, forHTTPHeaderField: "X-Image-Data-Hash")
        request.setValue(fullHash, forHTTPHeaderField: "X-Full-Hash")
        request.setValue(percentEncodeHeaderValue(caption), forHTTPHeaderField: "X-Description")
        request.setValue(isFavorite ? "true" : "false", forHTTPHeaderField: "X-Is-Favorite")
        request.setValue(capturedAtString, forHTTPHeaderField: "X-Captured-At")
        request.setValue(assetLocalId, forHTTPHeaderField: "X-Asset-Id")
        // GPS fallback — iOS's PHAssetResource bytes were observed to come back
        // with their EXIF stripped (no GPS, no DateTimeOriginal). PHAsset.location
        // is read separately by the caller and forwarded here; the server uses
        // these headers only when the file's own EXIF carries no coordinates.
        if let latitude, latitude.isFinite {
            request.setValue(String(latitude), forHTTPHeaderField: "X-GPS-Lat")
        }
        if let longitude, longitude.isFinite {
            request.setValue(String(longitude), forHTTPHeaderField: "X-GPS-Lng")
        }
        request.httpBody = data
        applyAuth(&request)
        print("""
        [Upload] \(filename)
          assetId:       \(assetLocalId)
          imageDataHash: \(imageDataHash)
          fullHash:      \(fullHash)
          caption:       \"\(caption)\"
          isFavorite:    \(isFavorite)
          capturedAt:    \(capturedAtString)
          gps:           \(latitude.map { String($0) } ?? "nil"),\(longitude.map { String($0) } ?? "nil")
        """)

        var (responseData, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401, let manager = authManager {
            let refreshed = await refreshOnce(manager: manager)
            if refreshed {
                applyAuth(&request)
                (responseData, response) = try await session.data(for: request)
            } else {
                manager.handleUnauthorized()
                throw APIError.httpError(401, parseErrorMessage(responseData))
            }
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        print("[Upload] \(filename) → HTTP \(http.statusCode)")
        switch http.statusCode {
        case 200:
            // Server had the photo already; only metadata was updated. Body: {updated:true, photoId}.
            let body = (try? JSONDecoder().decode(MetadataUpdateBody.self, from: responseData))
            let photoId = body?.photoId ?? 0
            print("[Upload] \(filename) → metadata-only update, photoId=\(photoId)")
            return .updated(photoId: photoId)
        case 201:
            let photo = try decoder.decode(Photo.self, from: responseData)
            print("[Upload] \(filename) → NEW photo created, id=\(photo.id)")
            return .created(photo)
        case 409:
            let photoId = (try? JSONDecoder().decode(DuplicatePhotoBody.self, from: responseData))?.photoId
            print("[Upload] \(filename) → duplicate (409), existingId=\(photoId as Any)")
            throw APIError.duplicatePhoto(photoId: photoId)
        case 401:
            authManager?.handleUnauthorized()
            throw APIError.httpError(401, parseErrorMessage(responseData))
        default:
            guard (200...299).contains(http.statusCode) else {
                throw APIError.httpError(http.statusCode, parseErrorMessage(responseData))
            }
            return .created(try decoder.decode(Photo.self, from: responseData))
        }
    }

    private struct DuplicatePhotoBody: Decodable {
        let photoId: Int?
    }

    private struct MetadataUpdateBody: Decodable {
        let updated: Bool?
        let photoId: Int?
    }

    // MARK: - Download (for photos/thumbnails)

    /// Issues a GET with an `If-None-Match` header. Returns `nil` when the
    /// server responded 304 Not Modified (caller's cached view is still
    /// current), otherwise returns the new ETag and the body. Used by the
    /// background sync to skip work when nothing changed (issue #303 phase 5).
    struct CachedResponse {
        let etag: String?
        let body: Data
    }

    func getWithETag(_ path: String, ifNoneMatch: String?, query: [String: String]? = nil) async throws -> CachedResponse? {
        let url = buildURL(path: path, query: query)
        var request = URLRequest(url: url, timeoutInterval: 30)
        request.httpMethod = "GET"
        if let ifNoneMatch { request.setValue(ifNoneMatch, forHTTPHeaderField: "If-None-Match") }
        applyAuth(&request)

        var (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401, let manager = authManager {
            if await refreshOnce(manager: manager) {
                applyAuth(&request)
                (data, response) = try await session.data(for: request)
            } else {
                manager.handleUnauthorized()
                throw APIError.httpError(401, parseErrorMessage(data))
            }
        }

        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        if http.statusCode == 304 { return nil }
        guard (200...299).contains(http.statusCode) else {
            if http.statusCode == 401 { authManager?.handleUnauthorized() }
            throw APIError.httpError(http.statusCode, parseErrorMessage(data))
        }
        let etag = http.value(forHTTPHeaderField: "ETag") ?? http.value(forHTTPHeaderField: "Etag")
        return CachedResponse(etag: etag, body: data)
    }

    func downloadData(_ path: String, query: [String: String]? = nil) async throws -> Data {
        let url = buildURL(path: path, query: query)
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        applyAuth(&request)

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }

        if httpResponse.statusCode == 401 {
            if let manager = authManager, await refreshOnce(manager: manager) {
                applyAuth(&request)
                let (retryData, retryResponse) = try await session.data(for: request)
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

    /// Percent-encodes a string for use in a custom HTTP header value.
    /// Encodes non-ASCII, spaces, and other characters that could break header parsing.
    private func percentEncodeHeaderValue(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.formUnion(.init(charactersIn: "-_.~!*'()"))
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    private func perform<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await session.data(for: request)

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
        let (data, response) = try await session.data(for: request)

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

    /// Proactively refreshes the access token when it expires within the next 2 minutes.
    /// Call before starting a long-running operation (e.g. drain loop) to avoid
    /// mid-session 401 logouts during upload queues that exceed the 15-minute token
    /// lifetime (issue #625).
    ///
    /// The access token is an opaque random string, not a JWT, so its expiry
    /// can't be read from the token itself — it comes from the server's
    /// `expiresAt` saved at login/refresh. When the expiry is known and more
    /// than 2 minutes away, do nothing. When it's unknown (older server, or not
    /// refreshed since the app updated), refresh once to establish it. This
    /// replaces the old JWT-parsing path that never matched and therefore
    /// force-rotated the refresh token on every call — each rotation was a
    /// chance to lose the new token if the background task was suspended,
    /// which surfaced as a logout after long background gaps.
    func ensureFreshToken() async {
        guard let manager = authManager else { return }
        if let expiry = manager.accessTokenExpiry, expiry.timeIntervalSinceNow > 120 {
            return
        }
        _ = await refreshOnce(manager: manager)
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
