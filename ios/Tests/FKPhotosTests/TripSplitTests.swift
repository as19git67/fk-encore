import XCTest
@testable import FKPhotosLib

/// Separating for an afternoon, as the screen reads it (§6.5).
///
/// A split is an attribute of a block: the branches hang off the block,
/// each with its own people and its own way back to one meeting point.
/// A block nobody split reads exactly as it always did.
final class TripSplitTests: XCTestCase {

    private let json = """
    { "id": "morning", "rowId": 4, "label": "Vormittag", "kind": "spots",
      "budgetMinutes": 210, "usedMinutes": 190, "startMinutes": 540, "stops": [],
      "branches": [
        { "id": 1, "position": 0, "label": "Ins Technikmuseum",
          "meetingLabel": "Am Brunnen", "meetingMinutes": 780, "budgetMinutes": 200,
          "members": [ { "key": "user:1", "name": "Anna" } ], "stops": [] },
        { "id": 2, "position": 1, "label": "Auf den Markt",
          "meetingLabel": "Am Brunnen", "meetingMinutes": 780, "budgetMinutes": 180,
          "members": [ { "key": "traveller:9", "name": "Kind A" },
                       { "key": "user:2", "name": "Papa" } ], "stops": [] }
      ] }
    """

    private func block() throws -> TripBlock {
        try JSONDecoder().decode(TripBlock.self, from: Data(json.utf8))
    }

    func testASplitBlockKnowsItIsSplit() throws {
        let block = try block()

        XCTAssertTrue(block.isSplit)
        XCTAssertEqual(block.branches?.count, 2)
    }

    func testEachBranchSaysWhoAndWhenTheyAreBack() throws {
        let branches = try XCTUnwrap(block().branches)

        XCTAssertEqual(branches[0].subtitle, "Anna · zurück um 13:00")
        XCTAssertEqual(branches[1].subtitle, "Kind A, Papa · zurück um 13:00")
    }

    func testBranchesMeetAtOneTimeAndMayHaveDifferentBudgets() throws {
        // The budget follows backwards from the meeting, so two branches
        // walking in opposite directions get different ones (§6.5).
        let branches = try XCTUnwrap(block().branches)

        XCTAssertEqual(Set(branches.map(\.meetingMinutes)), [780])
        XCTAssertNotEqual(branches[0].budgetMinutes, branches[1].budgetMinutes)
    }

    func testABlockNobodySplitReadsAsItAlwaysDid() throws {
        let json = """
        { "id": "afternoon", "rowId": 5, "label": "Nachmittag", "kind": "spots",
          "budgetMinutes": 180, "usedMinutes": 100, "startMinutes": 840, "stops": [] }
        """
        let block = try JSONDecoder().decode(TripBlock.self, from: Data(json.utf8))

        XCTAssertFalse(block.isSplit)
        XCTAssertNil(block.branches)
    }

    func testTheSuggestionIsAbsentWhenTheGroupAgrees() throws {
        let json = #"{ "suggestion": null }"#
        let answer = try JSONDecoder()
            .decode(TripSplitSuggestionResponse.self, from: Data(json.utf8))

        XCTAssertNil(answer.suggestion)
    }

    func testTheSuggestionNamesBothSidesAndWhoAsked() throws {
        let json = """
        { "suggestion": { "sentence": "… spalten die Gruppe …",
            "a": { "osmRef": "node:1", "name": "Technikmuseum", "voterNames": ["Anna"] },
            "b": { "osmRef": "node:2", "name": "Markt", "voterNames": ["Papa", "Kind A"] } } }
        """
        let answer = try JSONDecoder()
            .decode(TripSplitSuggestionResponse.self, from: Data(json.utf8))

        XCTAssertEqual(answer.suggestion?.a.name, "Technikmuseum")
        XCTAssertEqual(answer.suggestion?.b.voterNames, ["Papa", "Kind A"])
    }
}
