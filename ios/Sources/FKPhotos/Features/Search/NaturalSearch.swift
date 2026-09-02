import Foundation

/// The natural-language side of photo search: what the server understood a
/// free-form query to mean, and how to say that back to the user.
///
/// `POST /photos/search/natural` parses a German query like
/// „Kirchen in München von 2004 bis 2017" into a semantic part („Kirchen"),
/// a location („München") and a date range (2004-01-01 – 2017-12-31), then
/// runs the semantic search restricted to those. The plain
/// `POST /photos/search` does the semantic part only, so a query naming a
/// place or a year searched for the words rather than filtering by them.
///
/// The web shows the breakdown as a "Verstanden als:" chip row
/// (`useNaturalSearch` + `NaturalSearchBar.vue`); this is the same rule set,
/// so both clients label the same parse identically.
enum NaturalSearch {

    // MARK: - Wire format

    /// The server's structured reading of the query. Dates arrive as ISO 8601
    /// instants.
    struct ParsedQuery: Decodable, Equatable, Sendable {
        let semanticQuery: String
        let fromDate: String?
        let toDate: String?
        let location: String?

        init(
            semanticQuery: String,
            fromDate: String? = nil,
            toDate: String? = nil,
            location: String? = nil
        ) {
            self.semanticQuery = semanticQuery
            self.fromDate = fromDate
            self.toDate = toDate
            self.location = location
        }
    }

    /// One hit. Only `photoId` is used — the grid needs a full photo row, which
    /// the batch endpoint `GET /photos/details` provides; everything else here
    /// is a subset of it.
    struct Hit: Decodable, Sendable {
        let photoId: Int
    }

    struct Response: Decodable, Sendable {
        let results: [Hit]
        let parsed: ParsedQuery
    }

    /// Request body of `POST /photos/search/natural`. The server defaults
    /// `limit` to 500 and `threshold` to 0.18; the phone asks for fewer, since
    /// a thumbnail grid that far down is scrolled by nobody and every id costs
    /// a byte in the follow-up details request.
    struct Request: Encodable, Sendable {
        let query: String
        let limit: Int
        let threshold: Double

        init(query: String, limit: Int = 200, threshold: Double = 0.18) {
            self.query = query
            self.limit = limit
            self.threshold = threshold
        }
    }

    // MARK: - Chips

    /// One "Verstanden als:" chip.
    struct Chip: Equatable, Identifiable, Sendable {
        enum Kind: String, Sendable {
            case semantic, location, date
        }

        let kind: Kind
        let label: String

        var id: String { kind.rawValue }

        /// SF Symbol matching the web's PrimeIcon for the same chip.
        var systemImage: String {
            switch kind {
            case .semantic: return "photo"
            case .location: return "mappin.and.ellipse"
            case .date: return "calendar"
            }
        }
    }

    /// The chips for a parse, in the web's order: what was searched for, where,
    /// when. Empty when the server found nothing worth reporting — the row is
    /// then not drawn at all.
    static func chips(
        for parsed: ParsedQuery?,
        query: String,
        calendar: Calendar = .current
    ) -> [Chip] {
        guard let parsed else { return [] }
        var out: [Chip] = []
        if let semantic = semanticLabel(for: parsed, query: query) {
            out.append(Chip(kind: .semantic, label: semantic))
        }
        if let location = locationLabel(for: parsed) {
            out.append(Chip(kind: .location, label: location))
        }
        if let date = dateLabel(for: parsed, calendar: calendar) {
            out.append(Chip(kind: .date, label: date))
        }
        return out
    }

    /// The semantic part, but only when it differs from what the user typed.
    /// A query the parser took nothing out of comes back unchanged, and
    /// echoing it under the search field says nothing.
    static func semanticLabel(for parsed: ParsedQuery, query: String) -> String? {
        let semantic = parsed.semanticQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !semantic.isEmpty else { return nil }
        let raw = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return semantic.lowercased() == raw.lowercased() ? nil : semantic
    }

    static func locationLabel(for parsed: ParsedQuery) -> String? {
        let location = (parsed.location ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return location.isEmpty ? nil : location
    }

    /// The date range in the shortest form that still says the same thing:
    /// a range covering whole years collapses to „2004" or „2004–2017",
    /// anything else spells the days out.
    ///
    /// The components are read in the device's own time zone, matching what
    /// the web does with `new Date(…).getFullYear()`. The server builds the
    /// bounds in *its* local time before serializing them, so a phone and a
    /// server in the same zone — the normal case here — round-trip exactly.
    static func dateLabel(
        for parsed: ParsedQuery,
        calendar: Calendar = .current
    ) -> String? {
        guard let from = date(fromISO: parsed.fromDate) else { return nil }
        let to = date(fromISO: parsed.toDate)

        let fromParts = calendar.dateComponents([.year, .month, .day], from: from)
        let toParts = to.map { calendar.dateComponents([.year, .month, .day], from: $0) }

        // Whole years: Jan 1 through Dec 31.
        if fromParts.month == 1, fromParts.day == 1,
           let toParts, toParts.month == 12, toParts.day == 31,
           let fromYear = fromParts.year, let toYear = toParts.year {
            return fromYear == toYear ? "\(fromYear)" : "\(fromYear)–\(toYear)"
        }

        let formatted = dayFormatter(calendar: calendar)
        guard let to else { return formatted.string(from: from) }
        let sameDay = fromParts == toParts
        return sameDay
            ? formatted.string(from: from)
            : "\(formatted.string(from: from)) – \(formatted.string(from: to))"
    }

    // MARK: - Helpers

    /// Parse an ISO 8601 instant, with or without fractional seconds. The
    /// server sends `Date.toISOString()` (always fractional), but the spaCy
    /// parser it falls back on is a separate service with its own formatting,
    /// so both are accepted.
    static func date(fromISO iso: String?) -> Date? {
        guard let iso, !iso.isEmpty else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: iso) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: iso) { return date }
        // A bare "2004-01-01" from the remote parser: read as local midnight,
        // the same day the user meant.
        let dayOnly = DateFormatter()
        dayOnly.locale = Locale(identifier: "en_US_POSIX")
        dayOnly.dateFormat = "yyyy-MM-dd"
        dayOnly.timeZone = TimeZone.current
        return dayOnly.date(from: iso)
    }

    private static func dayFormatter(calendar: Calendar) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "de_DE")
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "dd. MMM yyyy"
        return formatter
    }
}
