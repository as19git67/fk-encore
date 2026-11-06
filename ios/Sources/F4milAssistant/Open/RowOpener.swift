import Foundation
import F4milCore
import Observation

/// What happens when a row is tapped: the app first, then the PDF preview,
/// then the web page. Holds what the chat screen presents.
@MainActor
@Observable
final class RowOpener {
    let host: AssistantHost
    let api: AssistantAPI
    var pdf: PDFItem?
    var web: WebItem?
    var error: String?

    init(host: AssistantHost, api: AssistantAPI) {
        self.host = host
        self.api = api
    }

    func open(route: String) {
        Task { await openNow(route: route) }
    }

    private func openNow(route: String) async {
        let server = await api.serverURL()
        guard let url = RouteResolver.webURL(for: route, serverURL: server) else {
            error = "Der Link ist nicht lesbar."
            return
        }
        if host.openRoute(route, url) { return }
        switch RouteResolver.target(for: route) {
        case .documentPDF(let id):
            pdf = .document(id: id)
        case .web:
            // Signed in as the app's user through a one-time handover token
            // (assistent-ios.md, stage 5); the plain page, which asks for a
            // login once, when the server would not issue one.
            web = WebItem(url: await WebHandover.signedInURL(for: route, client: api.client) ?? url)
        }
    }

    /// A card ran and left a PDF behind (`result_download`): show it, with the share sheet.
    func openDownload(path: String, title: String) {
        pdf = .file(path: path, title: title)
    }
}

/// What the PDF preview shows: a document by id, or a file the API serves
/// at a path (a card's result).
enum PDFItem: Identifiable, Hashable {
    case document(id: Int)
    case file(path: String, title: String)

    var id: String {
        switch self {
        case .document(let id): return "document:\(id)"
        case .file(let path, _): return "file:\(path)"
        }
    }

    var title: String {
        switch self {
        case .document: return "Dokument"
        case .file(_, let title): return title
        }
    }

    func load(with api: AssistantAPI) async throws -> Data {
        switch self {
        case .document(let id): return try await api.documentFile(id: id)
        case .file(let path, _): return try await api.file(at: path)
        }
    }

    var fileStem: String {
        switch self {
        case .document(let id): return "assistant-document-\(id)"
        case .file: return "assistant-result"
        }
    }
}

struct WebItem: Identifiable, Hashable {
    let url: URL
    var id: String { url.absoluteString }
}
