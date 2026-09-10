import XCTest
@testable import FKPhotosLib

/// The paperwork screen, as it reads the server's answer (§3.4).
///
/// Two things decide whether this screen helps: a document a traveller
/// may not read says so instead of showing an empty title, and a time
/// read off a ticket is shown as a reading — the clock plus the line it
/// came from — rather than as a fact.
final class TripDocumentsTests: XCTestCase {

    private let json = """
    {
      "documents": [
        { "id": 1, "documentId": 41, "role": "transport", "note": null,
          "linkedBy": "Anna", "readable": true, "title": "Fahrkarte",
          "sender": "Bahnunternehmen", "docDate": "2026-07-12",
          "hints": [
            { "label": "Abfahrt", "kind": "departure", "minutes": 1065,
              "evidence": "Abfahrt 17:45 Gleis 4" },
            { "label": "Ankunft", "kind": "appointment", "minutes": 1263,
              "evidence": "Ankunft 21:03" }
          ] },
        { "id": 2, "documentId": 42, "role": "lodging", "note": null,
          "linkedBy": "Papa", "readable": false, "title": null,
          "sender": null, "docDate": null, "hints": [] }
      ]
    }
    """

    private func documents() throws -> [TripDocument] {
        try JSONDecoder().decode(TripDocumentsResponse.self, from: Data(json.utf8)).documents
    }

    func testAReadableDocumentShowsWhatItIs() throws {
        let ticket = try documents()[0]

        XCTAssertEqual(ticket.displayTitle, "Fahrkarte")
        XCTAssertEqual(ticket.symbolName, "tram")
        XCTAssertEqual(ticket.subtitle, "Bahnunternehmen · 12.07.2026 · von Anna")
    }

    func testADocumentSomebodyElseUploadedKeepsItsContentsToItself() throws {
        // The trip is shared, the paperwork is not: the row says one is
        // attached and who attached it, and nothing else.
        let other = try documents()[1]

        XCTAssertEqual(other.displayTitle, "Ein Dokument von Papa")
        XCTAssertNil(other.title)
        XCTAssertTrue(other.hints.isEmpty)
        XCTAssertEqual(other.subtitle,
                       "von Papa · nur für den sichtbar, der es hochgeladen hat")
    }

    func testATimeIsShownWithTheLineItWasReadFrom() throws {
        // A reading, not a fixpoint (§4.4): OCR misreads, and the
        // evidence is what lets somebody catch it.
        let hints = try documents()[0].hints

        XCTAssertEqual(hints[0].clock, "17:45")
        XCTAssertEqual(hints[0].symbolName, "arrow.right.to.line")
        XCTAssertTrue(hints[0].evidence.contains("Gleis 4"))
        XCTAssertEqual(hints[1].clock, "21:03")
        XCTAssertEqual(hints[1].symbolName, "clock")
    }

    func testASuggestionCarriesTheReasonItWasMade() throws {
        let json = """
        { "suggestions": [
            { "documentId": 7, "title": "Hotelbuchung", "sender": null,
              "docDate": "2026-01-04", "role": "lodging",
              "reasons": ["nennt Lissabon"] } ] }
        """
        let offered = try JSONDecoder()
            .decode(TripDocumentSuggestionsResponse.self, from: Data(json.utf8))

        XCTAssertEqual(offered.suggestions.count, 1)
        XCTAssertEqual(offered.suggestions[0].id, 7)
        XCTAssertEqual(offered.suggestions[0].symbolName, "bed.double")
        XCTAssertEqual(offered.suggestions[0].reasons, ["nennt Lissabon"])
    }

    func testADateIsWrittenTheWayItIsRead() {
        XCTAssertEqual(TripDocumentWording.german("2026-07-12"), "12.07.2026")
        // Not a date: handed back untouched rather than mangled.
        XCTAssertEqual(TripDocumentWording.german("später"), "später")
    }
}
