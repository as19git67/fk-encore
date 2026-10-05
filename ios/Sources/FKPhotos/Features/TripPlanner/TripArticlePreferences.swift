import Foundation

/// Which languages the reader can read as they are (§25, stage C).
///
/// The server translates every article that is not German — right for
/// most people, wrong for somebody who reads English or Italian and
/// would rather have the text as written than a machine's German of
/// it. So the app keeps a list of languages not to translate, said
/// once in the trip settings, and sends it with every article request;
/// only the server knows which language an article turns out to be in.
///
/// Stored as a comma-separated list of codes ("en,it") under one key,
/// so the setting reads the same from a `@AppStorage` and from a plain
/// `UserDefaults` lookup.
enum TripArticlePreferences {
    static let keepLanguagesKey = "tripPlanner.articleKeepLanguages"

    /// The languages on offer: the ones a European trip is likely to
    /// meet, plus the few far away ones with large Wikipedias. German
    /// is not among them — there is nothing to translate.
    static let offeredCodes: [String] = [
        "en", "fr", "it", "es", "pt", "nl", "da", "sv", "nb", "fi", "is",
        "pl", "cs", "sk", "hu", "sl", "hr", "ro", "bg", "el", "tr",
        "et", "lv", "lt", "ru", "uk", "ja", "zh",
    ]

    /// "en, IT,, nonsense" → ["en", "it"]: codes only, lower case, in
    /// the order given, nothing twice, never German.
    static func codes(from stored: String) -> [String] {
        var seen = Set<String>()
        return stored
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
            .filter { code in
                guard code != "de", isCode(code), !seen.contains(code) else { return false }
                seen.insert(code)
                return true
            }
    }

    /// The form the server reads: "en,it".
    static func stored(from codes: [String]) -> String {
        Self.codes(from: codes.joined(separator: ",")).joined(separator: ",")
    }

    static func load(_ defaults: UserDefaults = .standard) -> [String] {
        codes(from: defaults.string(forKey: keepLanguagesKey) ?? "")
    }

    /// "Italienisch" — the system's word, or the code when it has none.
    static func name(of code: String) -> String {
        Locale.current.localizedString(forLanguageCode: code) ?? code
    }

    private static func isCode(_ code: String) -> Bool {
        let parts = code.split(separator: "-")
        guard let first = parts.first, (2...3).contains(first.count),
              first.allSatisfy({ $0.isLetter }) else { return false }
        return parts.dropFirst().allSatisfy { !$0.isEmpty && $0.allSatisfy { $0.isLetter || $0.isNumber } }
    }
}
