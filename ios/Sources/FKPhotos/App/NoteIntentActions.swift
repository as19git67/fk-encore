import Foundation

/// Notes from Siri, the Shortcuts app and the Action button: a new note in
/// the documents module, or a line added to the end of one. Both run without
/// opening the app and without the assistant — the text goes to the server
/// as it was said, so it is quick and needs no model. The intents themselves
/// live in the app target (`ios/App/Intents.swift`).
extension IntentActions {

    public struct NoteRef: Sendable, Identifiable {
        public let id: Int
        public let title: String
        /// The first line of the text, for the picker.
        public let excerpt: String
    }

    /// The text documents the user sees, newest first; `matching` narrows by title.
    public static func notes(matching query: String? = nil) async throws -> [NoteRef] {
        var params = ["limit": "50"]
        if let query, !query.isEmpty { params["q"] = query }
        let response: TextDocumentListResponse = try await APIClient.shared.get("/documents/text-documents", query: params)
        return response.documents.map { NoteRef(id: $0.id, title: $0.title, excerpt: $0.excerpt) }
    }

    /// Files a new note with what was said; returns the sentence to speak.
    public static func createNote(text: String, title: String?) async -> String {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return "Es gab nichts zu notieren." }
        let given = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let name = given.isEmpty ? NoteTitle.from(body) : given
        do {
            let doc: TextDocumentWire = try await APIClient.shared.post(
                "/documents/text",
                body: CreateTextDocumentBody(title: name, markdown: body)
            )
            return "Notiert in „\(doc.title ?? name)“."
        } catch {
            return NoteTitle.failure(error, doing: "Die Notiz konnte nicht angelegt werden")
        }
    }

    /// Adds what was said at the end of a note; a plain line to a note that
    /// ends in a list becomes its next item. Returns the sentence to speak.
    public static func appendToNote(id: Int, title: String, text: String) async -> String {
        let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty else { return "Es gab nichts hinzuzufügen." }
        do {
            let _: TextDocumentWire = try await APIClient.shared.post(
                "/documents/\(id)/text/append",
                body: AppendTextBody(text: line, follow_list: true)
            )
            return "Zu „\(title)“ hinzugefügt."
        } catch {
            return NoteTitle.failure(error, doing: "Das konnte nicht zu „\(title)“ hinzugefügt werden")
        }
    }
}

/// How a spoken note is named and how a failure is said.
public enum NoteTitle {
    static let maxLength = 60

    /// The first line, cut at a word before `maxLength`: „Filter der
    /// Lüftung im März tauschen" names itself.
    public static func from(_ text: String) -> String {
        let firstLine = text
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty } ?? ""
        let line = firstLine.trimmingCharacters(in: CharacterSet(charactersIn: ".!?:;,… "))
        guard !line.isEmpty else { return "Notiz" }
        guard line.count > maxLength else { return line }
        var title = ""
        for word in line.split(separator: " ") {
            let next = title.isEmpty ? String(word) : "\(title) \(word)"
            if next.count > maxLength - 1 { break }
            title = next
        }
        return (title.isEmpty ? String(line.prefix(maxLength - 1)) : title) + "…"
    }

    /// What Siri says when the server refused: a missing right reads as such.
    public static func failure(_ error: Error, doing what: String) -> String {
        if case let APIError.httpError(code, _) = error {
            if code == 403 { return "\(what): Dafür fehlt dir das Recht für Dokumente." }
            if code == 404 { return "\(what): Die Notiz gibt es nicht mehr." }
            if code == 409 { return "\(what): Die Notiz wurde gerade geändert. Versuch es noch einmal." }
        }
        return "\(what)."
    }
}

struct TextDocumentListResponse: Decodable {
    struct Item: Decodable {
        let id: Int
        let title: String
        let excerpt: String
    }
    let documents: [Item]
}

struct TextDocumentWire: Decodable {
    let id: Int
    let title: String?
}

struct CreateTextDocumentBody: Encodable {
    let title: String
    let markdown: String
}

struct AppendTextBody: Encodable {
    let text: String
    let follow_list: Bool
}
