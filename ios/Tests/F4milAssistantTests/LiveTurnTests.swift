import XCTest
@testable import F4milAssistant

/// The phone's reading of a turn, event by event — the same as the web's
/// (frontend/src/utils/assistantTurn.ts), so the two never show a turn
/// differently.
final class LiveTurnTests: XCTestCase {
    private func block(_ kind: String) -> ResultBlock {
        ResultBlock(kind: kind, tool: "t", rows: [], title: kind)
    }

    func testTokensAccumulate() {
        var turn = LiveTurn()
        turn.apply(StreamEvent(type: "token", text: "Hal"))
        turn.apply(StreamEvent(type: "token", text: "lo"))
        XCTAssertEqual(turn.text, "Hallo")
        XCTAssertFalse(turn.finished)
    }

    func testASentenceBeforeAToolCallStaysAsADraft() {
        var turn = LiveTurn()
        turn.apply(StreamEvent(type: "token", text: "Ich schaue nach. "))
        turn.apply(StreamEvent(type: "tool_start", tool: "list_transactions"))
        XCTAssertEqual(turn.text, "")
        XCTAssertEqual(turn.drafts, [TurnDraft(text: "Ich schaue nach.", withdrawn: false)])
        XCTAssertEqual(turn.steps.map(\.label), ["Buchungen durchsuchen"])
        XCTAssertFalse(turn.steps[0].done)
    }

    func testAWithdrawnAnswerIsMarkedSo() {
        var turn = LiveTurn()
        turn.apply(StreamEvent(type: "token", text: "Du hast 3 Konten."))
        turn.apply(StreamEvent(type: "retract"))
        XCTAssertEqual(turn.drafts, [TurnDraft(text: "Du hast 3 Konten.", withdrawn: true)])
        XCTAssertEqual(turn.text, "")
    }

    func testAnEmptyDraftIsNotKept() {
        var turn = LiveTurn()
        turn.apply(StreamEvent(type: "token", text: "  \n"))
        turn.apply(StreamEvent(type: "tool_start", tool: "list_accounts"))
        XCTAssertTrue(turn.drafts.isEmpty)
    }

    func testAResultClosesTheOldestOpenStepOfItsToolAndBringsItsBlock() {
        var turn = LiveTurn()
        turn.apply(StreamEvent(type: "tool_start", tool: "list_accounts"))
        turn.apply(StreamEvent(type: "tool_start", tool: "list_accounts"))
        turn.apply(StreamEvent(type: "tool_result", tool: "list_accounts", row_count: 2, block: block("accounts")))
        XCTAssertTrue(turn.steps[0].done)
        XCTAssertEqual(turn.steps[0].rowCount, 2)
        XCTAssertFalse(turn.steps[1].done)
        XCTAssertEqual(turn.blocks.map(\.kind), ["accounts"])
    }

    func testAFailedToolKeepsItsError() {
        var turn = LiveTurn()
        turn.apply(StreamEvent(type: "tool_start", tool: "search_photos"))
        turn.apply(StreamEvent(type: "tool_result", tool: "search_photos", row_count: 0, error: "unknown argument"))
        XCTAssertEqual(turn.steps[0].error, "unknown argument")
        XCTAssertTrue(turn.blocks.isEmpty)
    }

    func testDoneReplacesTextAndBlocksAndClosesEveryStep() {
        var turn = LiveTurn()
        turn.apply(StreamEvent(type: "tool_start", tool: "list_accounts"))
        turn.apply(StreamEvent(type: "token", text: "Ent"))
        turn.apply(StreamEvent(type: "done", answer: "Entwurf fertig.", blocks: [block("accounts"), block("table")], message_id: 12))
        XCTAssertTrue(turn.finished)
        XCTAssertEqual(turn.text, "Entwurf fertig.")
        XCTAssertEqual(turn.blocks.map(\.kind), ["accounts", "table"])
        XCTAssertTrue(turn.steps.allSatisfy(\.done))
        XCTAssertEqual(turn.messageId, 12)
    }

    func testNothingChangesAfterTheEnd() {
        var turn = LiveTurn()
        turn.apply(StreamEvent(type: "error", message: "kaputt"))
        turn.apply(StreamEvent(type: "token", text: "noch was"))
        XCTAssertTrue(turn.finished)
        XCTAssertEqual(turn.error, "kaputt")
        XCTAssertEqual(turn.text, "")
    }

    func testCancelledEndsWithoutAnError() {
        let turn = LiveTurn().applying(StreamEvent(type: "cancelled"))
        XCTAssertTrue(turn.finished)
        XCTAssertNil(turn.error)
    }

    func testAnUnknownToolReadsAsItsName() {
        XCTAssertEqual(ToolLabels.label(for: "some_new_tool"), "some new tool")
        XCTAssertEqual(ToolLabels.label(for: "render_letter"), "Brief entwerfen")
    }

    func testSuggestionsFollowThePermissions() {
        XCTAssertEqual(SuggestedQuestions.questions(has: { _ in false }), [])
        XCTAssertEqual(SuggestedQuestions.questions(has: { $0 == "photos.view" }).count, 1)
        XCTAssertEqual(SuggestedQuestions.questions(has: { _ in true }).count, 4)
    }
}
