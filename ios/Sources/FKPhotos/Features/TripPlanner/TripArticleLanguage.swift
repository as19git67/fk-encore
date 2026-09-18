import Foundation

/// Which language an article is in, before somebody opens it (§10.4).
///
/// OpenStreetMap's `wikipedia` tag names the article **in the local
/// language**, and the server now prefers the German one wherever the
/// map knows of it. Wherever it does not, the link still leads to
/// Italian, Portuguese or Czech — and that is fine as long as it is
/// said in advance. A button marked only „Artikel lesen“ that opens a
/// page nobody in the car can read is a small broken promise; the same
/// button with „auf Italienisch“ under it is an honest offer, and iOS
/// can translate the page once it is open.
///
/// The language is read out of the address rather than stored beside
/// it: `it.wikipedia.org` says it already, and a second field would be
/// a second source for one fact.
enum TripArticleLanguage {

    /// The article's language as a word — „Italienisch“ — or nil when
    /// it is German, not a Wikipedia address, or a code the system has
    /// no name for.
    ///
    /// German answers nil on purpose: the point of this is the warning,
    /// and „Artikel lesen (Deutsch)“ is noise on a German screen.
    static func name(of url: URL) -> String? {
        guard let code = code(of: url), code != "de" else { return nil }
        return Locale.current.localizedString(forLanguageCode: code)
    }

    /// "it" for `https://it.wikipedia.org/wiki/Colosseo`, including the
    /// mobile form `it.m.wikipedia.org`.
    static func code(of url: URL) -> String? {
        guard let host = url.host()?.lowercased(), host.hasSuffix(".wikipedia.org") else {
            return nil
        }
        let code = host.split(separator: ".").first.map(String.init) ?? ""
        // "www.wikipedia.org" is the portal, not an article in any one
        // language, and "m." is the mobile host of the same portal.
        guard !code.isEmpty, code != "www", code != "m" else { return nil }
        return code
    }
}
