import SwiftUI
import UniformTypeIdentifiers

/// A trip or the idea collection as a JSON file, and back
/// (`trip-planner/exchange.ts` on the server).
///
/// The app never decodes the file: the server writes it, the server
/// reads it back and checks it field by field, so the format has one
/// owner and an older app can still pass on a newer file.
enum TripExchange {
    struct ImportedTrip: Decodable, Sendable {
        let planId: Int
        let title: String?
    }

    struct ImportedIdeas: Decodable, Sendable {
        let added: Int
        let skipped: Int
    }

    static func exportTrip(planId: Int) async throws -> Data {
        try await APIClient.shared.downloadData("/trip-planner/plans/\(planId)/export")
    }

    static func importTrip(_ file: Data) async throws -> ImportedTrip {
        try await APIClient.shared.postJSONData("/trip-planner/plans/import", json: wrapped(file))
    }

    static func exportIdeas() async throws -> Data {
        try await APIClient.shared.downloadData("/trip-planner/ideas/export")
    }

    static func importIdeas(_ file: Data) async throws -> ImportedIdeas {
        try await APIClient.shared.postJSONData("/trip-planner/ideas/import", json: wrapped(file))
    }

    /// The endpoints take `{ "data": <file> }`. The file goes in as it
    /// is, byte for byte; if it is no JSON at all the server says so.
    static func wrapped(_ file: Data) -> Data {
        var body = Data(#"{"data":"#.utf8)
        body.append(file)
        body.append(Data("}".utf8))
        return body
    }

    /// Reads a file the document picker handed over. Files from iCloud
    /// or another app are security-scoped and must be opened as such.
    static func read(_ url: URL) throws -> Data {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        return try Data(contentsOf: url)
    }

    /// "Beispielreise.reise.json" — readable in Files, safe on every disk.
    static func fileName(_ title: String, suffix: String) -> String {
        let banned = CharacterSet(charactersIn: "/\\:?%*|\"<>")
        let cleaned = title.components(separatedBy: banned).joined(separator: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return "\(cleaned.isEmpty ? "Reise" : cleaned).\(suffix)"
    }

    /// "3 Ideen übernommen, 2 schon vorhanden."
    static func ideasOutcome(_ result: ImportedIdeas) -> String {
        let added = result.added == 1 ? "1 Idee übernommen" : "\(result.added) Ideen übernommen"
        guard result.skipped > 0 else { return added + "." }
        let skipped = result.skipped == 1 ? "1 war schon vorhanden" : "\(result.skipped) waren schon vorhanden"
        return "\(added), \(skipped)."
    }
}

/// The bytes of an exported file, for `.fileExporter`.
struct TripExchangeDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var data: Data

    init(data: Data) { self.data = data }

    init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}
