import XCTest
@testable import FKPhotosLib

/// Finding one spot on a ballot of thirty (§6.1, §20.1).
///
/// The list is right for the first pass and wrong for the second: what
/// somebody comes back for is one row, and what they remember about it
/// is rarely its name.
final class TripBallotSearchTests: XCTestCase {

    private func entry(
        ref: String = "node:1",
        name: String = "Palazzo Vecchio",
        label: String? = nil,
        category: String = "museum",
        wants: [String] = [],
        ratherNots: [String] = [],
        hearts: [String] = [],
    ) throws -> TripBallotEntry {
        let names = { (list: [String]) in
            "[" + list.map { "\"\($0)\"" }.joined(separator: ", ") + "]"
        }
        return try JSONDecoder().decode(TripBallotEntry.self, from: Data("""
        { "osmRef": "\(ref)", "name": "\(name)", "label": "\(label ?? name)",
          "category": "\(category)", "myVote": null, "myHeart": false,
          "wants": \(names(wants)), "ratherNots": \(names(ratherNots)),
          "hearts": \(names(hearts)), "planned": false }
        """.utf8))
    }

    private func details(line: String = "", note: String? = nil)
        -> TripBallotDetails.Details {
        TripBallotDetails.Details(spot: nil, line: line, note: note)
    }

    func testAnEmptySearchKeepsTheWholeBallot() throws {
        // The ballot is a list to work through until somebody types.
        let entries = [try entry(ref: "node:1"), try entry(ref: "node:2", name: "Dom")]
        XCTAssertEqual(
            TripBallotSearch.filter(entries, query: "   ") { _ in nil }.count, 2)
    }

    func testTheNameIsFoundWhateverTheCase() throws {
        let entries = [try entry(name: "Palazzo Vecchio")]
        XCTAssertEqual(
            TripBallotSearch.filter(entries, query: "vecchio") { _ in nil }.count, 1)
    }

    func testWhatKindOfPlaceItIsCounts() throws {
        // "Das Museum" is how somebody names a row they cannot name.
        let entries = [try entry(category: "museum")]
        XCTAssertEqual(
            TripBallotSearch.filter(entries, query: "Museum") { _ in nil }.count, 1)
    }

    func testTheDayAndBlockUnderTheNameAreSearchable() throws {
        // The row already says "Museum · 1 h 30 · Tag 2, Vormittag";
        // the search reads the same line, so "Tag 2" is a question the
        // screen can answer.
        let entries = [try entry()]
        let kept = TripBallotSearch.filter(entries, query: "Tag 2") { _ in
            self.details(line: "Museum · 1 h 30 · Tag 2, Vormittag")
        }
        XCTAssertEqual(kept.count, 1)
    }

    func testWhatSomebodyWroteNextToItCounts() throws {
        let entries = [try entry()]
        let kept = TripBallotSearch.filter(entries, query: "montags zu") { _ in
            self.details(note: "Montags zu — sagt Kim")
        }
        XCTAssertEqual(kept.count, 1)
    }

    func testAVoterIsFoundByName() throws {
        // "Was will eigentlich Alex?" is a question about the vote, and
        // the ballot is the only screen that knows.
        let entries = [
            try entry(ref: "node:1", name: "Palazzo", wants: ["Alex"]),
            try entry(ref: "node:2", name: "Dom", ratherNots: ["Kim"]),
            try entry(ref: "node:3", name: "Turm", hearts: ["Alex"]),
        ]
        let kept = TripBallotSearch.filter(entries, query: "Alex") { _ in nil }
        XCTAssertEqual(kept.map(\.osmRef), ["node:1", "node:3"])
    }

    func testNothingMatchingLeavesAnEmptyBallotRatherThanTheWholeOne() throws {
        let entries = [try entry(name: "Palazzo")]
        XCTAssertTrue(
            TripBallotSearch.filter(entries, query: "Biergarten") { _ in nil }.isEmpty)
    }

    func testTheOrderIsTheBallotsOwn() throws {
        // A search narrows the list; it does not rank it. A ranking is
        // exactly what §6.1 refuses to put on this screen.
        let entries = [
            try entry(ref: "node:1", name: "Alte Brücke"),
            try entry(ref: "node:2", name: "Brückenturm"),
            try entry(ref: "node:3", name: "Brücke am Park"),
        ]
        let kept = TripBallotSearch.filter(entries, query: "brück") { _ in nil }
        XCTAssertEqual(kept.map(\.osmRef), ["node:1", "node:2", "node:3"])
    }

    func testTheCountIsSaidOnlyWhenSomethingIsHidden() {
        XCTAssertNil(TripBallotSearch.countLabel(shown: 30, of: 30))
        XCTAssertEqual(TripBallotSearch.countLabel(shown: 3, of: 30), "3 von 30 Vorschlägen")
    }
}
