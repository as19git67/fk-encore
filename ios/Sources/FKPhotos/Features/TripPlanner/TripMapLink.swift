import Foundation

/// Reading a place out of a shared map link (§9.2, way 1).
///
/// The commonest way anything reaches this app: somebody sends an Apple
/// Maps link, you share it into F4mil. The link already carries what is
/// needed — a coordinate, often a name — so nothing has to be guessed,
/// asked or sent to a model.
///
/// Pure and free of any actor on purpose. It was a private method of
/// `TripShareReviewViewModel`, reachable only through a trip; the idea
/// collection needs the same reading without one, and a second copy of
/// this parsing would be a second place to get the date line wrong.
///
/// What it will **not** do is follow a short link — that needs the
/// network, and this stays a function of its input. `resolve(_:)` in
/// the view model does the following and hands the result back here.
enum TripMapLink {
    struct Place: Equatable, Sendable {
        let lat: Double
        let lon: Double
        /// What the link called it, where it said so.
        let name: String?
    }

    static func isMapLink(_ url: URL) -> Bool {
        url.host == "maps.apple.com" || url.host == "maps.apple" || url.scheme == "maps"
    }

    /// The place a link names, or nil when it names none.
    ///
    /// Apple Maps share URLs:
    ///   `https://maps.apple.com/?ll=48.3705,10.8978&q=Ort+Name&t=m`
    ///   `https://maps.apple.com/place?auid=…&ll=48.3705,10.8978&q=…`
    ///   `maps:q=Ort+Name&ll=48.3705,10.8978`
    ///
    /// A short link (`maps.apple/p/…`) carries no coordinate at all and
    /// answers nil here until somebody has resolved it.
    static func place(from url: URL) -> Place? {
        let params = parameters(of: url)
        guard let ll = params["ll"] else { return nil }
        let parts = ll.split(separator: ",")
        guard parts.count >= 2,
              let lat = Double(parts[0].trimmingCharacters(in: .whitespaces)),
              let lon = Double(parts[1].trimmingCharacters(in: .whitespaces)),
              (-90...90).contains(lat), (-180...180).contains(lon)
        else { return nil }

        // URLComponents percent-decodes query values; the plus is the
        // one separator it leaves behind.
        let name = params["q"]?
            .replacingOccurrences(of: "+", with: " ")
            .trimmingCharacters(in: .whitespaces)
        return Place(lat: lat, lon: lon, name: name?.isEmpty == true ? nil : name)
    }

    /// The link's parameters, whichever shape the sender's app used.
    ///
    /// `https://maps.apple.com/?ll=…` is an ordinary URL and
    /// `URLComponents` reads it. The `maps:` scheme is not: it is
    /// opaque, and a sender that writes `maps:q=Ort&ll=…` — with no
    /// question mark — leaves everything sitting in the path, where the
    /// query parser never looks. Reading only the first shape silently
    /// answered "no place here" for the second, which is the worst way
    /// to be wrong about a link: it looks like a link that carried
    /// nothing rather than one nobody read.
    private static func parameters(of url: URL) -> [String: String] {
        var items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        if items.isEmpty, let colon = url.absoluteString.firstIndex(of: ":") {
            var rest = String(url.absoluteString[url.absoluteString.index(after: colon)...])
            while rest.hasPrefix("/") { rest.removeFirst() }
            if rest.hasPrefix("?") { rest.removeFirst() }
            items = URLComponents(string: "?\(rest)")?.queryItems ?? []
        }
        var params: [String: String] = [:]
        for item in items {
            if let value = item.value { params[item.name] = value }
        }
        return params
    }

    static func place(from urlString: String) -> Place? {
        guard let url = URL(string: urlString), isMapLink(url) else { return nil }
        return place(from: url)
    }
}
