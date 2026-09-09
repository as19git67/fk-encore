import XCTest
@testable import FKPhotosLib

/// The ballot, as the screen reads it (§6.1).
///
/// The one thing this screen must never do is turn the answers into a
/// number: the whole chapter exists because an average picks what
/// everybody finds mediocre. So the row shows names, and a heart wish
/// shows whose it is.
final class TripBallotTests: XCTestCase {

    private let json = """
    {
      "legIndex": 0,
      "entries": [
        { "osmRef": "way:1", "name": "Aussichtsturm", "label": "Aussichtsturm",
          "category": "viewpoint",
          "myVote": "want", "myHeart": false,
          "wants": ["Anna", "Papa"], "ratherNots": [], "hearts": [], "planned": true },
        { "osmRef": "way:2", "name": "Höhlenweg", "label": "Höhlenweg",
          "category": "outdoors",
          "myVote": null, "myHeart": false,
          "wants": [], "ratherNots": ["Anna"], "hearts": ["Kind A"], "planned": false }
      ],
      "heartsLeft": 1,
      "heartQuota": 2,
      "silent": ["Oma"]
    }
    """

    private func ballot() throws -> TripBallot {
        try JSONDecoder().decode(TripBallot.self, from: Data(json.utf8))
    }

    func testTheRowNamesWhoSaidWhatRatherThanScoringIt() throws {
        let entry = try ballot().entries[0]

        XCTAssertEqual(entry.voices, "will: Anna, Papa")
        XCTAssertEqual(entry.myVote, "want")
        XCTAssertTrue(entry.planned)
    }

    func testAHeartWishIsShownAsSomebodysRatherThanAsAFlag() throws {
        // §6.1: the setting protects one person's preference, so whose
        // it is has to be visible.
        let entry = try ballot().entries[1]

        XCTAssertEqual(entry.voices, "Herzenswunsch: Kind A · lieber nicht: Anna")
        XCTAssertNil(entry.myVote)
    }

    func testTheSettingsLeftAreCarried() throws {
        let ballot = try ballot()

        XCTAssertEqual(ballot.heartsLeft, 1)
        XCTAssertEqual(ballot.heartQuota, 2)
        XCTAssertEqual(ballot.silent, ["Oma"])
    }

    func testAnUnnamedSpotIsCalledWhatItIsRatherThanItsReference() throws {
        // §15.3: never invent a name — say what the map knows and admit
        // the rest. `way:3` on a row is a reference nobody can vote on.
        let json = """
        { "legIndex": 0, "heartsLeft": 2, "heartQuota": 2, "silent": [],
          "entries": [ { "osmRef": "way:3", "name": null,
            "label": "Kirche (ohne Namen)", "category": "worship",
            "myVote": null, "myHeart": false, "wants": [], "ratherNots": [],
            "hearts": [], "planned": false } ] }
        """
        let ballot = try JSONDecoder().decode(TripBallot.self, from: Data(json.utf8))

        XCTAssertEqual(ballot.entries[0].label, "Kirche (ohne Namen)")
        XCTAssertNil(ballot.entries[0].name)
    }

    func testAnUndiscussedSpotShowsNothingRatherThanZeroes() throws {
        let json = """
        { "legIndex": 0, "heartsLeft": 2, "heartQuota": 2, "silent": [],
          "entries": [ { "osmRef": "way:3", "name": null,
            "label": "Sehenswürdigkeit (ohne Namen)", "category": "sight",
            "myVote": null, "myHeart": false, "wants": [], "ratherNots": [],
            "hearts": [], "planned": false } ] }
        """
        let ballot = try JSONDecoder().decode(TripBallot.self, from: Data(json.utf8))

        XCTAssertNil(ballot.entries[0].voices)
    }

    func testTheThreeAnswersAreTheOnesTheServerKnows() {
        XCTAssertEqual(TripVote.allCases.map(\.rawValue), ["want", "meh", "rather-not"])
    }

    func testTheFairnessAccountArrivesAsASentence() throws {
        let json = """
        { "rows": [ { "voter": "user:1", "name": "Anna", "granted": 0, "deferred": 2 } ],
          "sentence": "Anna musste bisher am ehesten zurückstecken." }
        """
        let fairness = try JSONDecoder().decode(TripFairness.self, from: Data(json.utf8))

        XCTAssertEqual(fairness.rows[0].id, "user:1")
        XCTAssertEqual(fairness.sentence, "Anna musste bisher am ehesten zurückstecken.")
    }
}
