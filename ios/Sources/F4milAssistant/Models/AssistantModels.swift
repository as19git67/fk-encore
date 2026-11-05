import Foundation

// The wire types of `/assistant` (assistant/assistant.ts, assistant/types.ts,
// assistant/present.ts). Field names are the server's, snake_case included,
// so a reader can hold the two sides against each other without a mapping
// table in between. Everything the phone does not use is simply not declared,
// so a server that adds a field changes nothing here.

public struct ConversationSummary: Codable, Hashable, Identifiable, Sendable {
    public let id: Int
    public let title: String?
    public let created_at: String
    public let updated_at: String

    public init(id: Int, title: String?, created_at: String, updated_at: String) {
        self.id = id
        self.title = title
        self.created_at = created_at
        self.updated_at = updated_at
    }

    /// What the list shows: the title the server gave the conversation, else a stand-in.
    public var displayTitle: String {
        let t = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return t.isEmpty ? "Neue Unterhaltung" : t
    }
}

/// One object of the working set the conversation was started with (#1534).
public struct ContextItem: Codable, Hashable, Sendable {
    public let type: String
    public let id: Int
    public let label: String
    public let visible: Bool
}

/// How a result row reads on a client that knows nothing about its kind
/// (`RowDisplay` in assistant/present.ts). Strings come formatted.
public struct RowDisplay: Codable, Hashable, Sendable {
    public var title: String
    public var subtitle: String?
    /// The figure at the right edge, already formatted.
    public var value: String?
    /// `in`, `out` or absent for neutral.
    public var tone: String?
    /// `TT.MM.JJJJ`, shown before the title.
    public var date: String?
    /// The web path that opens the object, without the `/app` prefix.
    public var route: String?
    public var thumbnail: DisplayThumbnail?

    public init(title: String, subtitle: String? = nil, value: String? = nil, tone: String? = nil,
                date: String? = nil, route: String? = nil, thumbnail: DisplayThumbnail? = nil) {
        self.title = title
        self.subtitle = subtitle
        self.value = value
        self.tone = tone
        self.date = date
        self.route = route
        self.thumbnail = thumbnail
    }
}

/// What to load a thumbnail for: a photo by its file name, a document by id.
public struct DisplayThumbnail: Codable, Hashable, Sendable {
    public let kind: String
    public let id: Int
    public let filename: String?

    public init(kind: String, id: Int, filename: String? = nil) {
        self.kind = kind
        self.id = id
        self.filename = filename
    }
}

/// One row of a block: the fields the tool returned, and the `display` the
/// server put beside them. The fields stay as they came; the phone reads
/// `display` and, for a kind it draws itself, the id.
public struct ResultRow: Codable, Hashable, Sendable {
    public let fields: [String: JSONValue]
    public let display: RowDisplay?

    public init(fields: [String: JSONValue], display: RowDisplay?) {
        self.fields = fields
        self.display = display
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        fields = try container.decode([String: JSONValue].self)
        // A row from before stage 1 has no display; the row still decodes.
        display = (try? DisplayCarrier(from: decoder))?.display
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(fields)
    }

    /// The object's id, when the row has one.
    public var id: Int? { fields["id"]?.intValue }

    private struct DisplayCarrier: Decodable {
        let display: RowDisplay?
    }
}

/// Rows the model saw, for the client (`ResultBlock` in assistant/types.ts).
public struct ResultBlock: Codable, Hashable, Sendable {
    public let kind: String
    public let tool: String
    public let rows: [ResultRow]
    /// How many exist, when more than `rows` holds.
    public let total: Int?
    /// A list page that shows the same set with the same filters.
    public let route: String?
    public let subtitle: String?
    /// The heading the server gives a block of this kind (stage 1).
    public let title: String?

    public init(kind: String, tool: String, rows: [ResultRow], total: Int? = nil,
                route: String? = nil, subtitle: String? = nil, title: String? = nil) {
        self.kind = kind
        self.tool = tool
        self.rows = rows
        self.total = total
        self.route = route
        self.subtitle = subtitle
        self.title = title
    }

    /// The heading, with a fallback for a block stored before the server sent titles.
    public var heading: String { title ?? "Ergebnis" }
}

public struct ConversationMessage: Codable, Hashable, Identifiable, Sendable {
    public let id: Int
    /// `user` or `assistant`.
    public let role: String
    public let content: String
    public let blocks: [ResultBlock]
    public let created_at: String

    public init(id: Int, role: String, content: String, blocks: [ResultBlock], created_at: String) {
        self.id = id
        self.role = role
        self.content = content
        self.blocks = blocks
        self.created_at = created_at
    }

    public var isUser: Bool { role == "user" }
}

public struct ConversationDetail: Codable, Sendable {
    public let id: Int
    public let title: String?
    public let created_at: String
    public let updated_at: String
    public let messages: [ConversationMessage]
    public let context: [ContextItem]

    public var summary: ConversationSummary {
        ConversationSummary(id: id, title: title, created_at: created_at, updated_at: updated_at)
    }
}

/// One frame of `/assistant/turns/:turnId/stream` (`StreamEvent` in
/// assistant/assistant.ts). One flat shape with optional fields, as the
/// server sends it; `type` says which of them are set.
public struct StreamEvent: Codable, Hashable, Sendable {
    public let type: String
    public var text: String?
    public var tool: String?
    public var arguments: [String: JSONValue]?
    public var row_count: Int?
    public var block: ResultBlock?
    public var error: String?
    public var answer: String?
    public var blocks: [ResultBlock]?
    public var message: String?
    public var message_id: Int?
    public var rounds: Int?
    public var code: String?

    public init(type: String, text: String? = nil, tool: String? = nil, arguments: [String: JSONValue]? = nil,
                row_count: Int? = nil, block: ResultBlock? = nil, error: String? = nil, answer: String? = nil,
                blocks: [ResultBlock]? = nil, message: String? = nil, message_id: Int? = nil,
                rounds: Int? = nil, code: String? = nil) {
        self.type = type
        self.text = text
        self.tool = tool
        self.arguments = arguments
        self.row_count = row_count
        self.block = block
        self.error = error
        self.answer = answer
        self.blocks = blocks
        self.message = message
        self.message_id = message_id
        self.rounds = rounds
        self.code = code
    }

    /// `done`, `error` and `cancelled` end a turn; nothing follows them.
    public var endsTurn: Bool { type == "done" || type == "error" || type == "cancelled" }
}

/// Whether the loaded model takes questions (`GET /assistant/model-gate`).
public struct ModelGate: Codable, Hashable, Sendable {
    /// `ok`, `slow`, `blocked`, `unmeasured` or `unknown`.
    public let state: String
    public let model: String?
    public let pass_rate: Double?
    public let threshold: Double
    /// What to show above the question field; nil when there is nothing to say.
    public let message: String?

    public init(state: String, model: String? = nil, pass_rate: Double? = nil, threshold: Double = 0.85, message: String? = nil) {
        self.state = state
        self.model = model
        self.pass_rate = pass_rate
        self.threshold = threshold
        self.message = message
    }

    /// `blocked` is the one state in which `ask` refuses.
    public var acceptsQuestions: Bool { state != "blocked" }
}
