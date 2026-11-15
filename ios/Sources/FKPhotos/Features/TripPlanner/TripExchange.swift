import SwiftUI
import UniformTypeIdentifiers

/// A trip, the idea collection or everything as a ZIP file, and back
/// (`trip-planner/exchange-file.ts` on the server).
///
/// The app never opens the file: the server packs it, names it with
/// date and time, unpacks it again and checks it field by field, so the
/// format has one owner and an older app can still pass on a newer file.
enum TripExchange {
    /// What a file holds, as the server names it.
    enum Kind: String, Codable, Sendable {
        case trip, ideas, all
    }

    struct ImportedTrip: Decodable, Sendable {
        let planId: Int
        let title: String?
    }

    struct ImportedIdeas: Decodable, Sendable {
        let added: Int
        let skipped: Int
    }

    struct ImportedPlanner: Decodable, Sendable {
        let trips: [ImportedTrip]
        let ideas: ImportedIdeas
    }

    /// "Beispielreise 2026-11-14 23-40.zip" and its bytes.
    struct ExportedFile: Sendable {
        let fileName: String
        let data: Data
    }

    struct ExportRequest: Encodable {
        let what: Kind
        let planId: Int?
        let timeZone: String
    }

    struct ExportResponse: Decodable {
        let fileName: String
        let zip: String
    }

    struct ImportRequest: Encodable {
        let file: String
        let expect: Kind
    }

    struct ImportResponse: Decodable, Sendable {
        let kind: Kind
        let trips: [ImportedTrip]
        let ideas: ImportedIdeas?
    }

    /// The server names the file in the phone's own time.
    static func exportRequest(_ what: Kind, planId: Int? = nil,
                              timeZone: TimeZone = .current) -> ExportRequest {
        ExportRequest(what: what, planId: planId, timeZone: timeZone.identifier)
    }

    static func export(_ what: Kind, planId: Int? = nil) async throws -> ExportedFile {
        let response: ExportResponse = try await APIClient.shared.post(
            "/trip-planner/export-file", body: exportRequest(what, planId: planId), timeout: 120)
        guard let data = Data(base64Encoded: response.zip) else { throw URLError(.cannotDecodeContentData) }
        return ExportedFile(fileName: response.fileName, data: data)
    }

    /// The ZIP (or a bare JSON file from an older export) as it is.
    /// A file of another kind than `expect` is refused by the server.
    static func importFile(_ file: Data, expect: Kind) async throws -> ImportResponse {
        try await APIClient.shared.post(
            "/trip-planner/import-file",
            body: ImportRequest(file: file.base64EncodedString(), expect: expect), timeout: 120)
    }

    /// Every trip you are on and your own ideas, in one file.
    static func exportPlanner() async throws -> ExportedFile {
        try await export(.all)
    }

    static func importPlanner(_ file: Data) async throws -> ImportedPlanner {
        let result = try await importFile(file, expect: .all)
        return ImportedPlanner(trips: result.trips, ideas: result.ideas ?? ImportedIdeas(added: 0, skipped: 0))
    }

    /// "2 Reisen angelegt. 3 Ideen übernommen, 1 war schon vorhanden."
    static func plannerOutcome(_ result: ImportedPlanner) -> String {
        let trips = result.trips.count == 1 ? "1 Reise angelegt." : "\(result.trips.count) Reisen angelegt."
        return "\(trips) \(ideasOutcome(result.ideas))"
    }

    static func exportTrip(planId: Int) async throws -> ExportedFile {
        try await export(.trip, planId: planId)
    }

    static func importTrip(_ file: Data) async throws -> ImportedTrip {
        let result = try await importFile(file, expect: .trip)
        guard let trip = result.trips.first else { throw URLError(.cannotParseResponse) }
        return trip
    }

    static func exportIdeas() async throws -> ExportedFile {
        try await export(.ideas)
    }

    static func importIdeas(_ file: Data) async throws -> ImportedIdeas {
        try await importFile(file, expect: .ideas).ideas ?? ImportedIdeas(added: 0, skipped: 0)
    }

    /// What the file picker offers: the ZIP, and the bare JSON of an
    /// export made before the ZIP.
    static let importTypes: [UTType] = [.zip, .json]

    /// Reads a file the document picker handed over. Files from iCloud
    /// or another app are security-scoped and must be opened as such.
    static func read(_ url: URL) throws -> Data {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        return try Data(contentsOf: url)
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
    static var readableContentTypes: [UTType] { [.zip] }
    var data: Data

    init(data: Data) { self.data = data }

    init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}
