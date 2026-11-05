import XCTest
@testable import F4milAssistant

/// The frames of `/assistant/turns/:turnId/stream`, as `toStreamEvent` in
/// assistant/assistant.ts writes them. A field the phone misreads here is a
/// turn that shows nothing on a device.
final class StreamEventTests: XCTestCase {
    private func decode(_ json: String) throws -> StreamEvent {
        try JSONDecoder().decode(StreamEvent.self, from: Data(json.utf8))
    }

    func testAPingCarriesNothing() throws {
        let event = try decode(#"{"type":"ping"}"#)
        XCTAssertEqual(event.type, "ping")
        XCTAssertFalse(event.endsTurn)
    }

    func testAToolResultCarriesItsCountAndBlock() throws {
        let event = try decode(#"""
        {"type":"tool_result","tool":"list_transactions","row_count":2,
         "block":{"kind":"transactions","tool":"list_transactions","title":"Buchungen","total":40,
                  "route":"/finanzen/umsaetze?q=Miete",
                  "rows":[{"id":7,"amount":"-12.50","display":{"title":"Miete","value":"-12,50 €","tone":"out","date":"04.03.2026","route":"/finanzen/umsaetze/7"}},
                          {"id":"8","display":{"title":"Gehalt","value":"2.000,00 €","tone":"in"}}]}}
        """#)
        XCTAssertEqual(event.row_count, 2)
        let block = try XCTUnwrap(event.block)
        XCTAssertEqual(block.heading, "Buchungen")
        XCTAssertEqual(block.total, 40)
        XCTAssertEqual(block.rows.count, 2)
        XCTAssertEqual(block.rows[0].display?.value, "-12,50\u{a0}€")
        XCTAssertEqual(block.rows[0].display?.tone, "out")
        XCTAssertEqual(block.rows[0].id, 7)
        // An id as a string, as some tools return them, is still an id.
        XCTAssertEqual(block.rows[1].id, 8)
        XCTAssertNil(block.rows[1].display?.route)
    }

    func testDoneCarriesTheStoredMessageId() throws {
        let event = try decode(#"{"type":"done","answer":"Zwei Buchungen.","blocks":[],"message_id":99,"rounds":2,"context_usage":{"used":1200,"window":32000,"estimated":1000,"budget":20000,"historyTurns":0,"keptTurns":0,"digested":0}}"#)
        XCTAssertTrue(event.endsTurn)
        XCTAssertEqual(event.message_id, 99)
        XCTAssertEqual(event.answer, "Zwei Buchungen.")
        XCTAssertEqual(event.blocks, [])
    }

    func testAnErrorCarriesItsCode() throws {
        let event = try decode(#"{"type":"error","message":"turn unknown","code":"not_found"}"#)
        XCTAssertTrue(event.endsTurn)
        XCTAssertEqual(TurnFollower.failure(ending: event), .lost)
        let other = try decode(#"{"type":"error","message":"Das Modell ist nicht verfügbar.","code":"unavailable"}"#)
        XCTAssertEqual(TurnFollower.failure(ending: other), .server(message: "Das Modell ist nicht verfügbar.", code: "unavailable"))
        XCTAssertEqual(TurnFollower.failure(ending: try decode(#"{"type":"cancelled"}"#)), .cancelled)
        XCTAssertNil(TurnFollower.failure(ending: try decode(#"{"type":"done","answer":""}"#)))
    }

    func testAFrameThatIsNotOursIsNoEvent() {
        XCTAssertNil(TurnFollower.decode(.string("hello")))
        XCTAssertEqual(TurnFollower.decode(.string(#"{"type":"token","text":"Hal"}"#))?.text, "Hal")
        XCTAssertEqual(TurnFollower.decode(.data(Data(#"{"type":"retract"}"#.utf8)))?.type, "retract")
    }

    func testAThumbnailNamesThePhotoOrTheDocument() throws {
        let photo = try JSONDecoder().decode(RowDisplay.self, from: Data(#"{"title":"Strand","thumbnail":{"kind":"photo","id":3,"filename":"abc.jpg"}}"#.utf8))
        XCTAssertEqual(photo.thumbnail, DisplayThumbnail(kind: "photo", id: 3, filename: "abc.jpg"))
        let document = try JSONDecoder().decode(RowDisplay.self, from: Data(#"{"title":"Rechnung","thumbnail":{"kind":"document","id":12}}"#.utf8))
        XCTAssertEqual(document.thumbnail, DisplayThumbnail(kind: "document", id: 12, filename: nil))
    }
}
