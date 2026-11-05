import Foundation

// What a running turn looks like on screen, built from the stream's events.
// A port of frontend/src/utils/assistantTurn.ts, kept pure so a test can
// feed it events: the web and the phone must read a turn the same way.
//
// Text belongs to the round it arrives in: the model may write a sentence
// before it calls tools, so a `tool_start` begins the answer afresh, and
// `done` carries the final answer either way. What was on screen before
// stays as a draft — a sentence before a tool call, or an answer the server
// withdrew to check it once more. Text the user has read never vanishes
// without a word.

/// One tool call of the turn, as the list of steps shows it.
public struct TurnStep: Hashable, Sendable, Identifiable {
    /// Position in the turn; the same tool may run twice.
    public let id: Int
    public let tool: String
    public let label: String
    public var done: Bool
    public var rowCount: Int?
    public var error: String?
}

/// Text of an earlier round that is no longer the answer.
public struct TurnDraft: Hashable, Sendable {
    public let text: String
    /// The server withdrew it (a claim without data behind it, an open plan step).
    public let withdrawn: Bool
}

public struct LiveTurn: Hashable, Sendable {
    public var text = ""
    /// What was written before the current round, oldest first.
    public var drafts: [TurnDraft] = []
    public var steps: [TurnStep] = []
    public var blocks: [ResultBlock] = []
    public var finished = false
    public var error: String?
    /// `done`: the stored answer's id.
    public var messageId: Int?

    public init() {}

    /// The current text kept as a draft before the next round begins.
    private mutating func keepDraft(withdrawn: Bool) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { drafts.append(TurnDraft(text: trimmed, withdrawn: withdrawn)) }
        text = ""
    }

    public mutating func apply(_ event: StreamEvent) {
        if finished { return }
        switch event.type {
        case "token":
            text += event.text ?? ""
        case "retract":
            // The server withdrew an answer that stated data without a tool behind it.
            keepDraft(withdrawn: true)
        case "tool_start":
            keepDraft(withdrawn: false)
            let tool = event.tool ?? "tool"
            steps.append(TurnStep(id: steps.count, tool: tool, label: ToolLabels.label(for: tool), done: false))
        case "tool_result":
            if let index = steps.firstIndex(where: { !$0.done && $0.tool == event.tool }) {
                steps[index].done = true
                steps[index].rowCount = event.row_count
                steps[index].error = event.error
            }
            if let block = event.block { blocks.append(block) }
        case "done":
            text = event.answer ?? text
            blocks = event.blocks ?? blocks
            for i in steps.indices { steps[i].done = true }
            messageId = event.message_id
            finished = true
        case "error":
            finished = true
            error = event.message ?? "Unbekannter Fehler"
        case "cancelled":
            finished = true
        default:
            break
        }
    }

    public func applying(_ event: StreamEvent) -> LiveTurn {
        var copy = self
        copy.apply(event)
        return copy
    }
}

/// What the user reads while a tool runs (`TOOL_LABELS` on the web).
public enum ToolLabels {
    static let labels: [String: String] = [
        "list_accounts": "Konten ansehen",
        "list_transactions": "Buchungen durchsuchen",
        "transaction_totals": "Summen berechnen",
        "upcoming_payments": "Erwartete Zahlungen vorausberechnen",
        "list_categories": "Kategorien ansehen",
        "search_documents": "Dokumente durchsuchen",
        "get_document_summary": "Dokument lesen",
        "get_document_text": "Dokument lesen",
        "list_photos": "Fotos durchsuchen",
        "search_photos": "Fotos nach Inhalt suchen",
        "list_recaps": "Rückblicke ansehen",
        "list_albums": "Alben ansehen",
        "list_persons": "Personen ansehen",
        "list_meters": "Zähler ansehen",
        "latest_readings": "Zählerstände lesen",
        "consumption_report": "Verbrauch berechnen",
        "list_trip_plans": "Reisepläne ansehen",
        "create_album": "Album vorschlagen",
        "add_photos_to_album": "Fotos für ein Album vorschlagen",
        "set_photo_favorite": "Favoriten vorschlagen",
        "create_photo_collage": "Collage vorschlagen",
        "create_photo_book": "Fotobuch vorschlagen",
        "create_document_follow_up": "Wiedervorlage vorschlagen",
        "tag_transactions": "Tags vorschlagen",
        "find_text_in_document": "In Dokumenten suchen",
        "create_collection": "Sammelmappe vorschlagen",
        "build_collection_pdf": "PDF vorschlagen",
        "transaction_report": "Bericht vorschlagen",
        "create_transaction_folder": "Regel-Sammelmappe vorschlagen",
        "render_letter": "Brief entwerfen",
        "write_plan": "Vorgehen planen",
        "switch_area": "Weitere Werkzeuge holen",
        "describe_tools": "Werkzeuge nachschlagen",
    ]

    public static func label(for tool: String) -> String {
        labels[tool] ?? tool.replacingOccurrences(of: "_", with: " ")
    }
}

/// First questions on an empty conversation, one per module the user has.
public enum SuggestedQuestions {
    public static func questions(has: (String) -> Bool) -> [String] {
        var out: [String] = []
        if has("finance.view") { out.append("Welche Lastschriften muss ich in diesem Monat noch erwarten?") }
        if has("documents.view") { out.append("Welche Versicherungsunterlagen habe ich letztes Jahr bekommen?") }
        if has("photos.view") { out.append("Welche Urlaubsreisen haben wir letztes Jahr gemacht?") }
        if has("meters.view") { out.append("Wie viel Strom haben wir letztes Jahr verbraucht?") }
        return out
    }
}
