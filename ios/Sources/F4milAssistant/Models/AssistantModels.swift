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

/// An object handed to a new conversation as its working set (#1534;
/// `ContextRef` in assistant/briefs.ts): what the app passes, before the
/// server has described it.
public struct ContextRef: Codable, Hashable, Sendable {
    public let type: String
    public let id: Int

    public init(type: String, id: Int) {
        self.type = type
        self.id = id
    }

    public static func photo(_ id: Int) -> ContextRef { ContextRef(type: "photo", id: id) }
    public static func document(_ id: Int) -> ContextRef { ContextRef(type: "document", id: id) }
    public static func transaction(_ id: Int) -> ContextRef { ContextRef(type: "transaction", id: id) }

    /// As many objects as the server keeps in one working set (`MAX_CONTEXT`).
    public static let maxItems = 25
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

// MARK: - Proposals (#1529, stage 4 of assistent-ios.md)

/// A write action the assistant proposed (`ProposalRow` in
/// assistant/proposals.ts). Nothing has happened yet: "Ausführen" runs it as
/// the user through the same endpoints the app's own buttons use,
/// "Verwerfen" drops it. Afterwards the row says what became of it.
public struct Proposal: Codable, Hashable, Sendable, Identifiable {
    public let proposal_id: Int
    public let tool: String
    public let summary: String
    public let count: Int?
    /// `pending`, `executing`, `executed` or `discarded`.
    public let status: String
    public let result_summary: String?
    /// The web path of what the action created, once it ran.
    public let result_route: String?
    /// An API path the result (a PDF) downloads from with the user's token.
    public let result_download: String?
    public let error: String?
    /// Set for a letter: what the card shows; editing is the web's (stage 4 leaves it there).
    public let letter: LetterDraft?
    /// Set for a text document: what will be filed.
    public let text_document: TextDocumentPreview?
    /// Set for a collage: what will be rendered, afterwards the photo it became.
    public let collage: CollagePreview?
    /// What the assistant goes on with once the card ran; the chat asks it to right after "Ausführen".
    public let continuation: String?

    public var id: Int { proposal_id }

    public init(proposal_id: Int, tool: String, summary: String, count: Int? = nil, status: String,
                result_summary: String? = nil, result_route: String? = nil, result_download: String? = nil,
                error: String? = nil, letter: LetterDraft? = nil, text_document: TextDocumentPreview? = nil,
                collage: CollagePreview? = nil, continuation: String? = nil) {
        self.proposal_id = proposal_id
        self.tool = tool
        self.summary = summary
        self.count = count
        self.status = status
        self.result_summary = result_summary
        self.result_route = result_route
        self.result_download = result_download
        self.error = error
        self.letter = letter
        self.text_document = text_document
        self.collage = collage
        self.continuation = continuation
    }

    public var isPending: Bool { status == "pending" }
    public var isExecuted: Bool { status == "executed" }
    public var isDiscarded: Bool { status == "discarded" }

    /// The status as the web's tag reads it.
    public var statusLabel: String {
        switch status {
        case "pending": return "Wartet auf Bestätigung"
        case "executing": return "Läuft"
        case "executed": return "Ausgeführt"
        case "discarded": return "Verworfen"
        default: return status
        }
    }

    /// The gaps left in a letter (`[[Zahlungsdatum]]`); "Ausführen" waits while there are any.
    public var letterGaps: [String] {
        guard let letter else { return [] }
        return LetterGaps.gaps(in: letter.sender, letter.recipient, letter.subject, letter.body)
    }

    /// A proposal read from a row of a `proposal` block.
    public init?(row: ResultRow) {
        guard let data = try? JSONEncoder().encode(JSONValue.object(row.fields)),
              let proposal = try? JSONDecoder().decode(Proposal.self, from: data) else { return nil }
        self = proposal
    }
}

public struct LetterAttachment: Codable, Hashable, Sendable {
    public let id: Int
    public let title: String

    public init(id: Int, title: String) {
        self.id = id
        self.title = title
    }
}

/// A letter as the card shows it (`LetterDraft` in assistant/proposals.ts).
public struct LetterDraft: Codable, Hashable, Sendable {
    public let sender: String
    public let recipient: String
    public let subject: String
    public let body: String
    public let attachments: [LetterAttachment]
    /// Photos printed after the letter, one per page; absent on older rows.
    public let photos: [LetterAttachment]?
    /// `document`, `collection`.
    public let destinations: [String]
    public let gaps: [String]?

    public init(sender: String, recipient: String, subject: String, body: String,
                attachments: [LetterAttachment] = [], photos: [LetterAttachment]? = nil,
                destinations: [String] = ["document"], gaps: [String]? = nil) {
        self.sender = sender
        self.recipient = recipient
        self.subject = subject
        self.body = body
        self.attachments = attachments
        self.photos = photos
        self.destinations = destinations
        self.gaps = gaps
    }
}

public struct TextDocumentPreview: Codable, Hashable, Sendable {
    public let title: String
    public let markdown: String

    public init(title: String, markdown: String) {
        self.title = title
        self.markdown = markdown
    }
}

/// A collage before it is rendered, and the photo it became (`CollagePreview`).
public struct CollagePreview: Codable, Hashable, Sendable {
    public struct Photo: Codable, Hashable, Sendable {
        public let id: Int
        public let filename: String

        public init(id: Int, filename: String) {
            self.id = id
            self.filename = filename
        }

        public var thumbnail: DisplayThumbnail { DisplayThumbnail(kind: "photo", id: id, filename: filename) }
    }

    public struct Result: Codable, Hashable, Sendable {
        public let photo_id: Int
        public let filename: String

        public init(photo_id: Int, filename: String) {
            self.photo_id = photo_id
            self.filename = filename
        }

        public var thumbnail: DisplayThumbnail { DisplayThumbnail(kind: "photo", id: photo_id, filename: filename) }
    }

    /// In cell order.
    public let photos: [Photo]
    public let layout: String
    public let text: String
    public let text_position: String
    public let text_size: String
    public let album_name: String?
    public let result: Result?

    public init(photos: [Photo], layout: String, text: String = "", text_position: String = "center",
                text_size: String = "medium", album_name: String? = nil, result: Result? = nil) {
        self.photos = photos
        self.layout = layout
        self.text = text
        self.text_position = text_position
        self.text_size = text_size
        self.album_name = album_name
        self.result = result
    }
}

extension ResultBlock {
    /// The proposals of a `proposal` block; empty for any other kind.
    public var proposals: [Proposal] {
        kind == "proposal" ? rows.compactMap(Proposal.init(row:)) : []
    }
}

/// A gap the assistant left in a letter for the user to fill in, written
/// `[[Zahlungsdatum]]` in the text (`letterGaps` on the web, #1534).
public enum LetterGaps {
    private static let pattern = try! NSRegularExpression(pattern: #"\[\[([^\]\n]{1,120})\]\]"#)

    /// The distinct gaps in the texts, in order of appearance.
    public static func gaps(in texts: String...) -> [String] {
        var out: [String] = []
        for text in texts {
            let range = NSRange(text.startIndex..., in: text)
            for match in pattern.matches(in: text, range: range) {
                guard let r = Range(match.range(at: 1), in: text) else { continue }
                let gap = text[r].trimmingCharacters(in: .whitespaces)
                if !out.contains(gap) { out.append(gap) }
            }
        }
        return out
    }
}

/// What happens around a card once it ran (`proposalEffects.ts` on the web).
public enum ProposalEffects {
    /// The question the chat asks for the assistant once a card ran: the rest
    /// of the question that needed its result.
    public static func continuationQuestion(summary: String, continuation: String) -> String {
        var trimmed = summary
        while let last = trimmed.last, last == "." || last.isWhitespace { trimmed.removeLast() }
        return "Die Karte ist ausgeführt: \(trimmed). Mach jetzt weiter: \(continuation)"
    }
}
