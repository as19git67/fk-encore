import Foundation

// MARK: - API client

/// Minimal HTTP client for the three API calls the share extension makes.
///
/// The main app's `APIClient` lives inside the `FKPhotos` library, which the
/// extension cannot import. Both the access token and the server URL are
/// mirrored to the App Group by `AuthManager.saveTokens` — this reads them
/// through `ShareAuth`, which also renews the session when the fifteen
/// minutes of an access token have run out. Without that, sharing a spot in
/// the afternoon failed as "not set up" for a session that was perfectly
/// valid.
///
/// The types it decodes into live in `ShareWireTypes.swift`, which is
/// where the rule about mirroring them is written down — and where the
/// tests that check the mirroring reach them from.
///
/// A request that fails is **never** answered with an empty list here.
/// `try?` around one of these calls is how a decoding bug became "you
/// have no idea collection, pick a trip" and stayed that way: the
/// callers show what went wrong instead.
enum ShareExtensionAPI {
    private static var baseURL: URL {
        ShareAuth.serverURL ?? URL(string: "http://localhost:4000")!
    }

    private static func url(for path: String) -> URL {
        let base = baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return URL(string: base + path)!
    }

    private static func authorise(_ request: inout URLRequest) {
        if let t = ShareAuth.token {
            request.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        }
    }

    private static func check(_ http: HTTPURLResponse, data: Data) throws {
        guard (200...299).contains(http.statusCode) else {
            struct Err: Decodable { let message: String? }
            let msg = (try? JSONDecoder().decode(Err.self, from: data))?.message
                ?? "HTTP \(http.statusCode)"
            throw NSError(domain: "ShareExtensionAPI", code: http.statusCode,
                          userInfo: [NSLocalizedDescriptionKey: msg])
        }
    }

    // MARK: - Trip list

    static func fetchPlans() async throws -> [SharePlanSummary] {
        struct Response: Decodable { let plans: [SharePlanSummary] }
        let (data, http) = try await ShareAuth.perform {
            var request = URLRequest(url: url(for: "/trip-planner/plans"), timeoutInterval: 20)
            request.httpMethod = "GET"
            authorise(&request)
            return request
        }
        try check(http, data: data)
        return try JSONDecoder().decode(Response.self, from: data).plans
    }

    // MARK: - Idea collections (§20)

    static func fetchIdeaCollections() async throws -> [ShareIdeaCollection] {
        struct Response: Decodable { let collections: [ShareIdeaCollection] }
        let (data, http) = try await ShareAuth.perform {
            var request = URLRequest(url: url(for: "/trip-planner/ideas"), timeoutInterval: 20)
            request.httpMethod = "GET"
            authorise(&request)
            return request
        }
        try check(http, data: data)
        return try JSONDecoder().decode(Response.self, from: data).collections
    }

    /// Put a place straight into a collection, with no trip in sight.
    static func addIdea(ownerId: Int?, lat: Double, lon: Double,
                        name: String?, note: String?, sourceUrl: String?,
                        dwellMinutes: Int?) async throws {
        struct Body: Encodable {
            let lat: Double; let lon: Double
            let ownerId: Int?
            let name: String?; let note: String?; let sourceUrl: String?
            let dwellMinutes: Int?
        }
        let body = try JSONEncoder().encode(Body(
            lat: lat, lon: lon, ownerId: ownerId,
            name: name?.isEmpty == false ? name : nil,
            note: note?.isEmpty == false ? note : nil,
            sourceUrl: sourceUrl,
            dwellMinutes: dwellMinutes))
        let (data, http) = try await ShareAuth.perform {
            var request = URLRequest(url: url(for: "/trip-planner/ideas"), timeoutInterval: 20)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
            authorise(&request)
            return request
        }
        try check(http, data: data)
    }

    // MARK: - Reading a map link (§9.2)

    /// What the shared link says, read by the server.
    ///
    /// The extension used to read it here, and knew one format: Apple's
    /// `ll=`. A link out of Google Maps therefore looked like a link
    /// carrying nothing, and since the collection is only offered for a
    /// share that has a coordinate, the picker showed trips and nothing
    /// else — the exact situation the idea pool exists to avoid.
    ///
    /// The server has read Apple, Google, OpenStreetMap, `geo:` and the
    /// short forms of all of them since the share sheet existed. It
    /// only ever hung off a trip, which is the one thing this share may
    /// not have.
    static func readMapLink(_ urlString: String) async throws -> ShareMapLinkRead {
        struct Body: Encodable { let url: String }
        let body = try JSONEncoder().encode(Body(url: urlString))
        let (data, http) = try await ShareAuth.perform {
            var request = URLRequest(url: url(for: "/trip-planner/map-link"), timeoutInterval: 20)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
            authorise(&request)
            return request
        }
        try check(http, data: data)
        return try JSONDecoder().decode(ShareMapLinkRead.self, from: data)
    }

    // MARK: - Analyse

    static func analyzeShare(planId: Int, url urlString: String?,
                             text: String?) async throws -> ShareAnalyzeResponse {
        struct Body: Encodable { let url: String?; let text: String? }
        let body = try JSONEncoder().encode(Body(url: urlString, text: text))
        let (data, http) = try await ShareAuth.perform {
            var request = URLRequest(url: url(for: "/trip-planner/plans/\(planId)/shares"),
                                     timeoutInterval: 30)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
            authorise(&request)
            return request
        }
        try check(http, data: data)
        return try JSONDecoder().decode(ShareAnalyzeResponse.self, from: data)
    }

    /// Synthetic single-proposal response for a map link that already carries
    /// coordinates — no server round-trip needed.
    static func syntheticResponse(lat: Double, lon: Double, name: String?,
                                  sourceUrl: String?) -> ShareAnalyzeResponse {
        ShareAnalyzeResponse(
            kind: "map-link",
            sourceUrl: sourceUrl,
            proposals: [ShareProposal(
                name: name, verdict: "coordinate",
                position: ShareProposal.Coordinate(lat: lat, lon: lon),
                osmRef: nil, categories: [], legIndex: nil, options: [],
                quote: nil, placeHint: nil
            )],
            rejected: []
        )
    }

    // MARK: - Add find

    /// Returns `true` when the server merged this with an existing pool entry.
    static func addFind(planId: Int, lat: Double, lon: Double,
                        name: String?, note: String?, sourceUrl: String?,
                        legIndex: Int?, dwellMinutes: Int?) async throws -> Bool {
        struct Body: Encodable {
            let lat: Double; let lon: Double
            let name: String?; let note: String?; let sourceUrl: String?
            let legIndex: Int?; let dwellMinutes: Int?
        }
        struct Response: Decodable { let merged: Bool }
        let body = try JSONEncoder().encode(Body(
            lat: lat, lon: lon,
            name: name?.isEmpty == false ? name : nil,
            note: note?.isEmpty == false ? note : nil,
            sourceUrl: sourceUrl,
            legIndex: legIndex,
            dwellMinutes: dwellMinutes))
        let (data, http) = try await ShareAuth.perform {
            var request = URLRequest(url: url(for: "/trip-planner/plans/\(planId)/finds"),
                                     timeoutInterval: 20)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
            authorise(&request)
            return request
        }
        try check(http, data: data)
        return (try? JSONDecoder().decode(Response.self, from: data))?.merged ?? false
    }
}
