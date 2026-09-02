import XCTest
@testable import FKPhotosLib

/// The comparison loop: which pair comes next, what a verdict moves, and when
/// the group is actually decided.
final class CompareTournamentTests: XCTestCase {

    // MARK: - Starting

    func testAGroupOfThreeStartsComparingAndKnowsItsPairCount() {
        let tournament = CompareTournament(photoIds: [1, 2, 3])
        XCTAssertEqual(tournament.phase, .comparing)
        XCTAssertEqual(tournament.totalPairs, 3)
        XCTAssertNotNil(tournament.current)
    }

    /// Nothing to compare is not an error — it is a group that is already
    /// decided.
    func testAGroupOfOneGoesStraightToConfirmation() {
        let tournament = CompareTournament(photoIds: [1])
        XCTAssertEqual(tournament.phase, .confirming)
        XCTAssertNil(tournament.current)
        XCTAssertEqual(tournament.suggestedKeepIds, [1])
    }

    // MARK: - The reported bug

    /// The whole point of #1085 §2a: one verdict used to end the group. In a
    /// group of four there are six pairs, and the first verdict settles one.
    func testOneVerdictDoesNotEndAFourPhotoGroup() {
        var tournament = CompareTournament(photoIds: [1, 2, 3, 4])
        XCTAssertEqual(tournament.totalPairs, 6)
        let first = tournament.current
        tournament.discard(first!.low)
        XCTAssertEqual(tournament.phase, .comparing)
        XCTAssertNotNil(tournament.current)
        XCTAssertNotEqual(tournament.current, first)
    }

    func testTheGroupIsOnlyDecidedOnceEveryPairIsSettled() {
        var tournament = CompareTournament(photoIds: [1, 2, 3])
        var guardCount = 0
        while let pair = tournament.current, guardCount < 10 {
            tournament.discard(pair.low)
            guardCount += 1
        }
        XCTAssertEqual(guardCount, 3)
        XCTAssertEqual(tournament.phase, .confirming)
    }

    // MARK: - Verdicts

    func testDiscardingMovesBothScores() {
        var tournament = CompareTournament(photoIds: [1, 2])
        tournament.discard(1)
        XCTAssertEqual(tournament.score(of: 1), -1)
        XCTAssertEqual(tournament.score(of: 2), 1)
    }

    func testADrawSettlesThePairWithoutMovingAnything() {
        var tournament = CompareTournament(photoIds: [1, 2])
        tournament.draw()
        XCTAssertEqual(tournament.score(of: 1), 0)
        XCTAssertEqual(tournament.score(of: 2), 0)
        XCTAssertEqual(tournament.phase, .confirming)
    }

    /// A skipped pair is postponed, not decided — with nothing else left it
    /// comes back rather than ending the tournament early.
    func testASkippedPairComesBackWhenNothingElseIsLeft() {
        var tournament = CompareTournament(photoIds: [1, 2])
        let pair = tournament.current
        tournament.skip()
        XCTAssertEqual(tournament.current, pair)
        XCTAssertEqual(tournament.phase, .comparing)
    }

    func testSkippingPrefersAnUnjudgedPair() {
        var tournament = CompareTournament(photoIds: [1, 2, 3])
        let first = tournament.current
        tournament.skip()
        XCTAssertNotEqual(tournament.current, first)
        XCTAssertEqual(tournament.comparisons, 0)
    }

    func testTheUserCanEndTheComparisonEarly() {
        var tournament = CompareTournament(photoIds: [1, 2, 3, 4])
        tournament.finishComparing()
        XCTAssertEqual(tournament.phase, .confirming)
        XCTAssertNil(tournament.current)
    }

    // MARK: - Pair order

    /// Swiss: the closest scores are compared first, because a photo that has
    /// won everything against one that has lost everything tells you nothing.
    func testTheClosestScoringPairComesNext() {
        let pair = CompareTournament.nextPair(
            photoIds: [1, 2, 3],
            scores: [1: 5, 2: 0, 3: 1],
            excluding: []
        )
        XCTAssertEqual(pair, CompareTournament.Pair(2, 3))
    }

    func testAPairIsNeverOfferedTwice() {
        let excluded: Set<CompareTournament.Pair> = [CompareTournament.Pair(1, 2)]
        let pair = CompareTournament.nextPair(
            photoIds: [1, 2], scores: [:], excluding: excluded
        )
        XCTAssertNil(pair)
    }

    /// The pair is unordered: judging 1 against 2 must also settle 2 against 1.
    func testAPairIsTheSameEitherWayRound() {
        XCTAssertEqual(CompareTournament.Pair(9, 7), CompareTournament.Pair(7, 9))
    }

    // MARK: - The keep set

    func testOnlyPhotosThatLostMoreThanTheyWonAreProposedForHiding() {
        var tournament = CompareTournament(photoIds: [1, 2, 3])
        // The lower id loses every pair it appears in, so 1 loses twice, 2
        // breaks even and 3 wins twice.
        while let pair = tournament.current {
            tournament.discard(pair.low)
        }
        XCTAssertFalse(tournament.suggestedKeepIds.contains(1))
        XCTAssertEqual(Set(tournament.suggestedKeepIds), [2, 3])
    }

    /// A group nobody judged proposes keeping everything. Hiding photos off
    /// the back of no evidence is exactly the failure this replaces.
    func testAnUnjudgedGroupKeepsEverything() {
        let tournament = CompareTournament(photoIds: [1, 2, 3])
        XCTAssertEqual(Set(tournament.suggestedKeepIds), [1, 2, 3])
    }

    /// `pick-photos` refuses an empty keep set, so the proposal can never be
    /// empty either.
    func testSomethingIsAlwaysKept() {
        var tournament = CompareTournament(photoIds: [1, 2], seedScores: [1: -9, 2: -9])
        tournament.finishComparing()
        XCTAssertEqual(tournament.suggestedKeepIds.count, 1)
    }

    func testTheConfirmationListsTheBestFirst() {
        let tournament = CompareTournament(
            photoIds: [1, 2, 3], seedScores: [1: -2, 2: 3, 3: 0]
        )
        XCTAssertEqual(tournament.ranked, [2, 3, 1])
    }

    // MARK: - Seeding

    func testWidelySpreadQualitiesUseTheAbsoluteMapping() {
        let seeds = CompareTournament.seedScores(qualities: [1: 1.0, 2: 0.5, 3: 0.0])
        XCTAssertEqual(seeds[1], 3)
        XCTAssertEqual(seeds[2], 0)
        XCTAssertEqual(seeds[3], -3)
    }

    /// A burst scores within a hair of itself; the absolute mapping would flatten
    /// every photo to the same number and say nothing.
    func testNearIdenticalQualitiesAreSpreadWithinTheGroup() {
        let seeds = CompareTournament.seedScores(qualities: [1: 0.70, 2: 0.75])
        XCTAssertEqual(seeds[1], -3)
        XCTAssertEqual(seeds[2], 3)
    }

    /// An unscored photo has no opinion attached to it — which is not the same
    /// as scoring badly.
    func testAnUnscoredPhotoStartsNeutral() {
        let qualities: [Int: Double?] = [1: nil, 2: 0.9]
        let seeds = CompareTournament.seedScores(qualities: qualities)
        XCTAssertEqual(seeds[1], 0)
    }
}
