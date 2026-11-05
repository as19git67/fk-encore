import Foundation
import F4milCore

/// What the surrounding app lends the assistant
/// (documentation/plans/assistent-ios.md, "The assistant is a Swift package
/// of its own"). The package knows no app: it draws every row from its
/// `display` and, when a row is tapped, asks the app first. The Photos app
/// takes photos, albums, persons and recaps; a Finance app would take
/// accounts and bookings. What the app does not take opens as a PDF preview
/// (documents) or as the web page in an in-app browser.
public struct AssistantHost: Sendable {
    /// Tries to open a web path natively. `webURL` is the same path on the
    /// server, for an app that parses web links already. Returns true when
    /// the app took the row; the assistant then does nothing more.
    public var openRoute: @MainActor @Sendable (_ route: String, _ webURL: URL) -> Bool
    /// Whether the signed-in user holds a permission (`finance.view`, …);
    /// the empty chat suggests a first question per module they have.
    public var hasPermission: @Sendable (String) -> Bool

    public init(
        hasPermission: @escaping @Sendable (String) -> Bool = { _ in true },
        openRoute: @escaping @MainActor @Sendable (_ route: String, _ webURL: URL) -> Bool
    ) {
        self.hasPermission = hasPermission
        self.openRoute = openRoute
    }

    /// An app without screens of its own: every row opens in the web view.
    public static let webOnly = AssistantHost { _, _ in false }
}

/// Where a row's `route` leads when the app does not take it.
public enum RouteTarget: Equatable, Sendable {
    /// A document: its PDF, shown in a QuickLook preview.
    case documentPDF(id: Int)
    /// Everything else: the web page.
    case web
}

public enum RouteResolver {
    /// `/dokumente/123` (a query string allowed) is a document; a letter is one too,
    /// since the assistant files it under `/documents/generated`. Anything
    /// deeper (`/dokumente/mappen/3`) is a page, not a file.
    public static func target(for route: String) -> RouteTarget {
        let path = route.split(separator: "?", maxSplits: 1).first.map(String.init) ?? route
        let segments = path.split(separator: "/", omittingEmptySubsequences: true)
        if segments.count == 2, segments[0] == "dokumente", let id = Int(segments[1]) {
            return .documentPDF(id: id)
        }
        return .web
    }

    /// The web app's page for a route on the given server: origin plus `/app`
    /// (`AppDeepLink.appBasePath`) plus the route.
    public static func webURL(for route: String, serverURL: URL) -> URL? {
        let origin = serverURL.absoluteString.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        let path = route.hasPrefix("/") ? route : "/" + route
        return URL(string: origin + AppDeepLink.appBasePath + path)
    }
}
