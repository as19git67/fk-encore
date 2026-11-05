import Foundation
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
            pdf = PDFItem(documentId: id)
        case .web:
            web = WebItem(url: url)
        }
    }
}

struct PDFItem: Identifiable, Hashable {
    let documentId: Int
    var id: Int { documentId }
}

struct WebItem: Identifiable, Hashable {
    let url: URL
    var id: String { url.absoluteString }
}
