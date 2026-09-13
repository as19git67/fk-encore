import Foundation

// MARK: - Models

struct SharePlanSummary: Decodable, Identifiable {
    let id: Int
    let title: String?
    let legTitles: [String?]

    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        let named = legTitles.compactMap { $0 }.filter { !$0.isEmpty }
        return named.isEmpty ? "Reise" : named.joined(separator: " \u{2192} ")
    }
}

/// A collection the share may go into instead of a trip (§20).
///
/// The whole point of the idea pool is that it needs no trip, and until
/// now the share sheet insisted on one: a map link somebody sent could
/// only be saved into a journey that already existed.
///
/// A mirror of the server's `IdeaCollection`, and the mirroring is the
/// part to be careful about: this file cannot import the app's own
/// `TripIdeaCollection`, and nothing compiles the two against each
/// other. This type once declared a `label` the server has never sent,
/// so every decode threw `keyNotFound`, the list came back empty, and
/// the picker offered trips only — the exact symptom the collection was
/// added to remove.
///
/// So the fields are the three the server actually sends, and the label
/// is computed here from them, word for word as the app computes it.
struct ShareIdeaCollection: Decodable, Identifiable {
    let ownerId: Int
    /// Whose it is. Null for one's own — the server names other people,
    /// not the caller.
    let ownerName: String?
    let own: Bool

    var id: Int { ownerId }

    var label: String {
        if own { return "Mein Vorrat" }
        guard let ownerName, !ownerName.isEmpty else { return "Geteilter Vorrat" }
        return "Vorrat von \(ownerName)"
    }
}

/// What the server made of a shared link.
///
/// Three answers, and the caller has to tell them apart: a place, a
/// page that is not a map link at all, and a short link nobody could
/// follow — only the last is worth trying again.
struct ShareMapLinkRead: Decodable, Sendable {
    let isMapLink: Bool
    let lat: Double?
    let lon: Double?
    let name: String?
    let unresolved: Bool
}

struct ShareProposal: Decodable, Identifiable, Sendable {
    let name: String?
    let verdict: String
    let position: Coordinate?
    let osmRef: String?
    let categories: [String]
    let legIndex: Int?
    let options: [Option]
    let quote: String?
    let placeHint: String?

    struct Coordinate: Decodable, Sendable {
        let lat: Double
        let lon: Double
    }

    struct Option: Decodable, Identifiable, Hashable, Sendable {
        let osmRef: String
        let name: String?
        let lat: Double
        let lon: Double
        let legIndex: Int
        let distanceM: Double?
        var id: String { osmRef }
    }

    var id: String { "\(verdict)|\(osmRef ?? "")|\(name ?? "")|\(quote ?? "")" }

    var canAdd: Bool { position != nil || osmRef != nil }

    var needsDuration: Bool {
        verdict == "coordinate" || (verdict == "none" && position != nil)
    }

    var needsChoice: Bool { verdict == "ambiguous" }
}

struct ShareAnalyzeResponse: Decodable, Sendable {
    let kind: String
    let sourceUrl: String?
    let proposals: [ShareProposal]
    let rejected: [String]
}

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
/// **Every wire type above is hand-mirrored and nothing checks it.** CI
/// does compile this file — `xcodebuild -target F4milShare`, since
/// #1120 — but compiling is all it does: the extension has no tests,
/// and a mirrored type that names a field the server never sends
/// compiles perfectly. It fails at run time, inside a `JSONDecoder`, on
/// a device, and a swallowed decoding error then looks like an empty
/// list rather than a bug (`ShareIdeaCollection` above).
///
/// So: only fields the server really sends, optionals for everything it
/// may omit, and anything derived (a label, a title) computed here
/// rather than expected from the wire.
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
