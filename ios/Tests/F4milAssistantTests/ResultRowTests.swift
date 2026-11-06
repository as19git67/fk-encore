import XCTest
@testable import F4milAssistant

/// A row is whatever the tool returned, plus the server's `display`.
final class ResultRowTests: XCTestCase {
    func testTheFieldsStayAsTheyCameAndDisplayIsReadBesideThem() throws {
        let row = try JSONDecoder().decode(ResultRow.self, from: Data(#"{"id":5,"amount":-3.5,"ok":true,"tags":["a"],"display":{"title":"Bäcker","value":"-3,50 €"}}"#.utf8))
        XCTAssertEqual(row.id, 5)
        XCTAssertEqual(row.fields["amount"], .number(-3.5))
        XCTAssertEqual(row.fields["ok"], .bool(true))
        XCTAssertEqual(row.fields["tags"], .array([.string("a")]))
        XCTAssertEqual(row.display?.title, "Bäcker")
    }

    func testARowFromBeforeTheDisplaysStillDecodes() throws {
        let row = try JSONDecoder().decode(ResultRow.self, from: Data(#"{"id":5,"name":"Girokonto"}"#.utf8))
        XCTAssertNil(row.display)
        XCTAssertEqual(ResultRowView.fallbackTitle(row), "Girokonto")
        let bare = try JSONDecoder().decode(ResultRow.self, from: Data(#"{"id":17}"#.utf8))
        XCTAssertEqual(ResultRowView.fallbackTitle(bare), "#17")
    }

    func testEncodingWritesTheFieldsBack() throws {
        let row = ResultRow(fields: ["id": .number(1), "display": .object(["title": .string("x")])], display: RowDisplay(title: "x"))
        let data = try JSONEncoder().encode(row)
        let again = try JSONDecoder().decode(ResultRow.self, from: data)
        XCTAssertEqual(again, row)
    }

    func testABlockWithoutATitleHasAFallbackHeading() throws {
        let block = try JSONDecoder().decode(ResultBlock.self, from: Data(#"{"kind":"table","tool":"x","rows":[]}"#.utf8))
        XCTAssertEqual(block.heading, "Ergebnis")
    }

    func testJSONValueReadsNumbersAsText() {
        XCTAssertEqual(JSONValue.number(42).stringValue, "42")
        XCTAssertEqual(JSONValue.number(4.5).stringValue, "4.5")
        XCTAssertEqual(JSONValue.string("12").intValue, 12)
        XCTAssertNil(JSONValue.number(4.5).intValue)
        XCTAssertNil(JSONValue.null.stringValue)
    }
}
