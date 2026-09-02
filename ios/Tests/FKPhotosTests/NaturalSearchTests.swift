import XCTest
@testable import FKPhotosLib

/// The "Verstanden als:" chips: what the server made of a free-form query,
/// said back in the same words the web uses (`useNaturalSearch`).
final class NaturalSearchChipTests: XCTestCase {

    /// Berlin, where the server building these bounds also runs. Fixed so the
    /// labels do not depend on the CI runner's zone.
    private var calendar: Calendar = {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Berlin")!
        return cal
    }()

    /// Berlin-local wall time as the server serializes it (UTC instant).
    private func iso(_ local: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "Europe/Berlin")!
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        let date = formatter.date(from: local)!
        let out = ISO8601DateFormatter()
        out.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        out.timeZone = TimeZone(identifier: "UTC")!
        return out.string(from: date)
    }

    // MARK: - Date

    func testAWholeYearRangeCollapsesToTheYears() {
        let parsed = NaturalSearch.ParsedQuery(
            semanticQuery: "Kirchen",
            fromDate: iso("2004-01-01 00:00:00"),
            toDate: iso("2017-12-31 23:59:59")
        )
        XCTAssertEqual(NaturalSearch.dateLabel(for: parsed, calendar: calendar), "2004–2017")
    }

    func testASingleWholeYearIsJustTheYear() {
        let parsed = NaturalSearch.ParsedQuery(
            semanticQuery: "Kirchen",
            fromDate: iso("2019-01-01 00:00:00"),
            toDate: iso("2019-12-31 23:59:59")
        )
        XCTAssertEqual(NaturalSearch.dateLabel(for: parsed, calendar: calendar), "2019")
    }

    func testAMonthSpellsBothEndsOut() {
        // "im März 2019" → 1.–31. März, not a whole year, so it is written out.
        let parsed = NaturalSearch.ParsedQuery(
            semanticQuery: "Kirchen",
            fromDate: iso("2019-03-01 00:00:00"),
            toDate: iso("2019-03-31 23:59:59")
        )
        let label = NaturalSearch.dateLabel(for: parsed, calendar: calendar)
        XCTAssertEqual(label?.contains("2019"), true)
        XCTAssertEqual(label?.contains(" – "), true)
        XCTAssertEqual(label?.hasPrefix("01."), true)
    }

    func testOneDayIsNotWrittenTwice() {
        let parsed = NaturalSearch.ParsedQuery(
            semanticQuery: "Kirchen",
            fromDate: iso("2019-03-05 00:00:00"),
            toDate: iso("2019-03-05 23:59:59")
        )
        let label = NaturalSearch.dateLabel(for: parsed, calendar: calendar)
        XCTAssertEqual(label?.contains(" – "), false)
        XCTAssertEqual(label?.hasPrefix("05."), true)
    }

    func testAnOpenEndedRangeShowsOnlyItsStart() {
        let parsed = NaturalSearch.ParsedQuery(
            semanticQuery: "Kirchen",
            fromDate: iso("2019-03-05 00:00:00")
        )
        let label = NaturalSearch.dateLabel(for: parsed, calendar: calendar)
        XCTAssertEqual(label?.contains(" – "), false)
        XCTAssertEqual(label?.hasPrefix("05."), true)
    }

    func testNoDateMeansNoChip() {
        let parsed = NaturalSearch.ParsedQuery(semanticQuery: "Kirchen")
        XCTAssertNil(NaturalSearch.dateLabel(for: parsed, calendar: calendar))
    }

    func testATrailingDateWithoutAStartIsIgnored() {
        // A range needs a start; a lone end has nothing to label.
        let parsed = NaturalSearch.ParsedQuery(
            semanticQuery: "Kirchen",
            toDate: iso("2017-12-31 23:59:59")
        )
        XCTAssertNil(NaturalSearch.dateLabel(for: parsed, calendar: calendar))
    }

    // MARK: - Semantic

    func testTheSemanticChipIsSilentWhenNothingWasParsedOut() {
        let parsed = NaturalSearch.ParsedQuery(semanticQuery: "Sonnenuntergang")
        XCTAssertNil(NaturalSearch.semanticLabel(for: parsed, query: "Sonnenuntergang"))
    }

    func testTheSemanticChipIgnoresCaseAndPadding() {
        let parsed = NaturalSearch.ParsedQuery(semanticQuery: "sonnenuntergang")
        XCTAssertNil(NaturalSearch.semanticLabel(for: parsed, query: "  Sonnenuntergang  "))
    }

    func testTheSemanticChipShowsWhatIsLeftOfTheQuery() {
        let parsed = NaturalSearch.ParsedQuery(semanticQuery: "Kirchen", location: "München")
        XCTAssertEqual(
            NaturalSearch.semanticLabel(for: parsed, query: "Kirchen in München"),
            "Kirchen"
        )
    }

    func testAnEmptySemanticQueryHasNoChip() {
        // "in München" parses to a location and nothing else.
        let parsed = NaturalSearch.ParsedQuery(semanticQuery: "  ", location: "München")
        XCTAssertNil(NaturalSearch.semanticLabel(for: parsed, query: "in München"))
    }

    // MARK: - Location

    func testTheLocationChipIsTheParsedPlace() {
        let parsed = NaturalSearch.ParsedQuery(semanticQuery: "Kirchen", location: "München")
        XCTAssertEqual(NaturalSearch.locationLabel(for: parsed), "München")
    }

    func testABlankLocationIsNoLocation() {
        let parsed = NaturalSearch.ParsedQuery(semanticQuery: "Kirchen", location: "   ")
        XCTAssertNil(NaturalSearch.locationLabel(for: parsed))
    }

    // MARK: - The row

    func testTheChipsReadWhatWhereWhen() {
        let parsed = NaturalSearch.ParsedQuery(
            semanticQuery: "Kirchen",
            fromDate: iso("2004-01-01 00:00:00"),
            toDate: iso("2017-12-31 23:59:59"),
            location: "München"
        )
        let chips = NaturalSearch.chips(
            for: parsed,
            query: "Kirchen in München von 2004 bis 2017",
            calendar: calendar
        )
        XCTAssertEqual(chips.map(\.kind), [.semantic, .location, .date])
        XCTAssertEqual(chips.map(\.label), ["Kirchen", "München", "2004–2017"])
    }

    func testAPlainQueryProducesNoRow() {
        let parsed = NaturalSearch.ParsedQuery(semanticQuery: "Sonnenuntergang am Meer")
        XCTAssertTrue(
            NaturalSearch.chips(
                for: parsed,
                query: "Sonnenuntergang am Meer",
                calendar: calendar
            ).isEmpty
        )
    }

    func testNoParseYetMeansNoRow() {
        XCTAssertTrue(NaturalSearch.chips(for: nil, query: "Kirchen", calendar: calendar).isEmpty)
    }

    func testEveryChipHasItsOwnIcon() {
        let icons = Set(
            [NaturalSearch.Chip.Kind.semantic, .location, .date]
                .map { NaturalSearch.Chip(kind: $0, label: "x").systemImage }
        )
        XCTAssertEqual(icons.count, 3)
    }
}

/// Decoding what `POST /photos/search/natural` actually sends back.
final class NaturalSearchWireTests: XCTestCase {

    func testAFullResponseDecodes() throws {
        let json = """
        {
          "results": [
            {"photoId": 7, "score": 0.42, "filename": "a.jpg", "created_at": "2024-01-01T00:00:00.000Z",
             "location_city": "Musterstadt", "location_country": "DE"},
            {"photoId": 3, "score": 0.31, "filename": "b.jpg", "created_at": "2024-01-02T00:00:00.000Z"}
          ],
          "parsed": {
            "semanticQuery": "Kirchen",
            "fromDate": "2003-12-31T23:00:00.000Z",
            "toDate": "2017-12-31T22:59:59.000Z",
            "location": "München"
          }
        }
        """.data(using: .utf8)!

        let response = try JSONDecoder().decode(NaturalSearch.Response.self, from: json)
        XCTAssertEqual(response.results.map(\.photoId), [7, 3])
        XCTAssertEqual(response.parsed.semanticQuery, "Kirchen")
        XCTAssertEqual(response.parsed.location, "München")
    }

    func testAParseWithoutDatesOrLocationDecodes() throws {
        let json = """
        {"results": [], "parsed": {"semanticQuery": "Sonnenuntergang"}}
        """.data(using: .utf8)!

        let response = try JSONDecoder().decode(NaturalSearch.Response.self, from: json)
        XCTAssertTrue(response.results.isEmpty)
        XCTAssertNil(response.parsed.fromDate)
        XCTAssertNil(response.parsed.toDate)
        XCTAssertNil(response.parsed.location)
    }

    func testTheRequestCarriesTheServerSideDefaults() throws {
        let body = try JSONEncoder().encode(NaturalSearch.Request(query: "Kirchen"))
        let sent = try XCTUnwrap(
            JSONSerialization.jsonObject(with: body) as? [String: Any]
        )
        XCTAssertEqual(sent["query"] as? String, "Kirchen")
        XCTAssertEqual(sent["limit"] as? Int, 200)
        XCTAssertEqual(sent["threshold"] as? Double, 0.18)
    }

    // MARK: - Date parsing

    func testFractionalAndPlainInstantsBothParse() {
        let withFraction = NaturalSearch.date(fromISO: "2004-01-01T00:00:00.000Z")
        let plain = NaturalSearch.date(fromISO: "2004-01-01T00:00:00Z")
        XCTAssertNotNil(withFraction)
        XCTAssertEqual(withFraction, plain)
    }

    func testABareDayFromTheRemoteParserIsReadAsLocalMidnight() throws {
        let date = try XCTUnwrap(NaturalSearch.date(fromISO: "2004-01-01"))
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone.current
        let parts = calendar.dateComponents([.year, .month, .day, .hour], from: date)
        XCTAssertEqual(parts.year, 2004)
        XCTAssertEqual(parts.month, 1)
        XCTAssertEqual(parts.day, 1)
        XCTAssertEqual(parts.hour, 0)
    }

    func testNonsenseIsNotADate() {
        XCTAssertNil(NaturalSearch.date(fromISO: nil))
        XCTAssertNil(NaturalSearch.date(fromISO: ""))
        XCTAssertNil(NaturalSearch.date(fromISO: "irgendwann"))
    }
}
