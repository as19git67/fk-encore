import XCTest
@testable import FKPhotosLib

/// How a note said to Siri is named (`NoteIntentActions.swift`).
final class NoteTitleTests: XCTestCase {
    func testTheFirstLineNamesTheNote() {
        XCTAssertEqual(NoteTitle.from("Filter der Lüftung im März tauschen."), "Filter der Lüftung im März tauschen")
        XCTAssertEqual(NoteTitle.from("\n  Gas ablesen\nam Samstag"), "Gas ablesen")
    }

    func testALongLineIsCutAtAWord() {
        let title = NoteTitle.from("Beim nächsten Besuch im Baumarkt unbedingt an die Dichtungen für den Wasserhahn in der Küche denken")
        XCTAssertTrue(title.hasSuffix("…"))
        XCTAssertLessThanOrEqual(title.count, NoteTitle.maxLength)
        XCTAssertFalse(title.dropLast().hasSuffix(" "))
        XCTAssertTrue("Beim nächsten Besuch im Baumarkt unbedingt an die Dichtungen".hasPrefix(String(title.dropLast())))
    }

    func testNothingButPunctuationIsANote() {
        XCTAssertEqual(NoteTitle.from(" … "), "Notiz")
        XCTAssertEqual(NoteTitle.from("!"), "Notiz")
    }

    func testAMissingRightIsSaid() {
        let said = NoteTitle.failure(APIError.httpError(403, nil), doing: "Die Notiz konnte nicht angelegt werden")
        XCTAssertEqual(said, "Die Notiz konnte nicht angelegt werden: Dafür fehlt dir das Recht für Dokumente.")
        XCTAssertEqual(NoteTitle.failure(APIError.invalidResponse, doing: "X"), "X.")
    }
}
