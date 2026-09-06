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
/// directly, without touching the Keychain.
enum ShareExtensionAPI {
    private static let appGroupID = "group.de.f4mil.photos"
    private static let tokenKey   = "shared.auth_token"
    private static let serverKey  = "shared.serverURL"

    private static var token: String? {
        UserDefaults(suiteName: appGroupID)?.string(forKey: tokenKey)
    }

    private static var baseURL: URL {
        let stored = UserDefaults(suiteName: appGroupID)?.string(forKey: serverKey) ?? ""
        return URL(string: stored) ?? URL(string: "http://localhost:4000")!
    }

    private static func url(for path: String) -> URL {
        let base = baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return URL(string: base + path)!
    }

    private static func authorise(_ request: inout URLRequest) {
        if let t = token {
            request.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        }
    }

    private static func check(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
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
        var request = URLRequest(url: url(for: "/trip-planner/plans"), timeoutInterval: 20)
        request.httpMethod = "GET"
        authorise(&request)
        let (data, response) = try await URLSession.shared.data(for: request)
        try check(response, data: data)
        return try JSONDecoder().decode(Response.self, from: data).plans
    }

    // MARK: - Analyse

    static func analyzeShare(planId: Int, url urlString: String?,
                             text: String?) async throws -> ShareAnalyzeResponse {
        struct Body: Encodable { let url: String?; let text: String? }
        var request = URLRequest(url: url(for: "/trip-planner/plans/\(planId)/shares"),
                                 timeoutInterval: 30)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(Body(url: urlString, text: text))
        authorise(&request)
        let (data, response) = try await URLSession.shared.data(for: request)
        try check(response, data: data)
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
        var request = URLRequest(url: url(for: "/trip-planner/plans/\(planId)/finds"),
                                 timeoutInterval: 20)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(Body(
            lat: lat, lon: lon,
            name: name?.isEmpty == false ? name : nil,
            note: note?.isEmpty == false ? note : nil,
            sourceUrl: sourceUrl,
            legIndex: legIndex,
            dwellMinutes: dwellMinutes))
        authorise(&request)
        let (data, response) = try await URLSession.shared.data(for: request)
        try check(response, data: data)
        return (try? JSONDecoder().decode(Response.self, from: data))?.merged ?? false
    }
}
