import XCTest
@testable import F4milAssistant

/// How an answer's Markdown is cut into paragraphs for `Text`.
final class MarkdownTextTests: XCTestCase {
    func testBlankLinesSeparateParagraphs() {
        let paragraphs = MarkdownText.paragraphs(of: "Erster Absatz.\n\nZweiter **fett**.")
        XCTAssertEqual(paragraphs, [.text("Erster Absatz."), .text("Zweiter **fett**.")])
    }

    func testAHeadingStandsAlone() {
        XCTAssertEqual(MarkdownText.paragraphs(of: "## Konten\n\nText"), [.heading("Konten"), .text("Text")])
        // A hash without a space is text, not a heading.
        XCTAssertEqual(MarkdownText.paragraphs(of: "#hashtag"), [.text("#hashtag")])
    }

    func testListItemsAreOneList() {
        XCTAssertEqual(
            MarkdownText.paragraphs(of: "- Miete\n- Strom\n* Wasser"),
            [.items(["Miete", "Strom", "Wasser"])]
        )
        XCTAssertEqual(MarkdownText.paragraphs(of: "1. eins\n2. zwei"), [.items(["eins", "zwei"])])
    }

    func testASentenceAboveAListKeepsBoth() {
        XCTAssertEqual(
            MarkdownText.paragraphs(of: "Drei Konten:\n- Giro\n- Tagesgeld"),
            [.text("Drei Konten:"), .items(["Giro", "Tagesgeld"])]
        )
    }

    func testInlineMarkdownBecomesAttributed() {
        let attributed = MarkdownText.inline("**12,50 €** bei *Bäcker*")
        XCTAssertEqual(String(attributed.characters), "12,50 € bei Bäcker")
    }
}
