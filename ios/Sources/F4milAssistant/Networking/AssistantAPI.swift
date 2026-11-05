import Foundation
import F4milCore

/// The REST side of the assistant: everything but the stream. Thin on
/// purpose — the backend was built for a second client already
/// (documentation/plans/assistent-ios.md, "What is there"); this maps its
/// endpoints one to one onto `APIClient`.
public struct AssistantAPI: Sendable {
    let client: APIClient

    public init(client: APIClient = .shared) {
        self.client = client
    }

    /// The server the app talks to; the web app lives under `/app` on it.
    public func serverURL() async -> URL {
        await client.baseURL
    }

    // MARK: - Conversations

    public func conversations() async throws -> [ConversationSummary] {
        let reply: ConversationList = try await client.get("/assistant/conversations")
        return reply.conversations
    }

    public func createConversation() async throws -> ConversationSummary {
        try await client.post("/assistant/conversations", body: EmptyBody())
    }

    public func conversation(_ id: Int) async throws -> ConversationDetail {
        try await client.get("/assistant/conversations/\(id)")
    }

    public func deleteConversation(_ id: Int) async throws {
        let _: Deleted = try await client.delete("/assistant/conversations/\(id)")
    }

    // MARK: - Turns

    /// Starts a turn; it returns at once and the answer comes over the
    /// stream of `turnId`. A refusal (empty question, model gate, rate
    /// limit) is this call's error.
    public func startTurn(conversation id: Int, message: String, turnId: String) async throws {
        let _: TurnStarted = try await client.post(
            "/assistant/conversations/\(id)/turns",
            body: StartTurnBody(message: message, turnId: turnId)
        )
    }

    /// False when the turn had already finished.
    public func cancelTurn(_ turnId: String) async throws -> Bool {
        let reply: Cancelled = try await client.post("/assistant/turns/\(turnId)/cancel", body: EmptyBody())
        return reply.cancelled
    }

    /// The socket that watches a turn. `resume` once the turn was started
    /// and the first socket dropped: the server then refuses an unknown turn
    /// at once instead of waiting for a question that never comes.
    public func streamRequest(turnId: String, resume: Bool) async -> URLRequest {
        await client.webSocketRequest(
            path: "/assistant/turns/\(turnId)/stream",
            query: resume ? ["resume": "true"] : nil
        )
    }

    public func modelGate() async throws -> ModelGate {
        try await client.get("/assistant/model-gate")
    }

    // MARK: - Files behind the rows

    /// The PDF of a document, for the preview.
    public func documentFile(id: Int) async throws -> Data {
        try await client.downloadData("/documents/\(id)/file")
    }

    /// The small image for a row: a photo scaled to `width`, a document's first page.
    public func thumbnail(_ thumbnail: DisplayThumbnail, width: Int) async throws -> Data {
        switch thumbnail.kind {
        case "photo":
            guard let filename = thumbnail.filename, !filename.isEmpty else { throw APIError.invalidResponse }
            return try await client.downloadData("/photos/file/\(filename)", query: ["w": String(width)])
        case "document":
            return try await client.downloadData("/documents/\(thumbnail.id)/thumbnail")
        default:
            throw APIError.invalidResponse
        }
    }

    // MARK: - Wire shapes

    private struct ConversationList: Decodable { let conversations: [ConversationSummary] }
    private struct Deleted: Decodable { let deleted: Bool }
    private struct Cancelled: Decodable { let cancelled: Bool }
    private struct TurnStarted: Decodable { let turnId: String }
    private struct StartTurnBody: Encodable { let message: String; let turnId: String }
    struct EmptyBody: Encodable {}
}

/// The id a client picks for a turn before posting it, so it can watch the
/// stream under that id (`TURN_ID_RE` in assistant/live.ts: 8–64 of
/// `[A-Za-z0-9_-]`).
public enum TurnID {
    public static func make() -> String {
        UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }

    public static func isValid(_ id: String) -> Bool {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_-"))
        return (8...64).contains(id.count)
            && id.unicodeScalars.allSatisfy { $0.isASCII && allowed.contains($0) }
    }
}
