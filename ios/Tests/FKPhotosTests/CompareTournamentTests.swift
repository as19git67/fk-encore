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

    /// Breaking even is not the same as winning: only the outright winner
    /// (3) is proposed, not 2, which merely didn't lose on balance.
    func testOnlyPhotosThatOutrightWonAreProposedForKeeping() {
        var tournament = CompareTournament(photoIds: [1, 2, 3])
        // The lower id loses every pair it appears in, so 1 loses twice, 2
        // breaks even and 3 wins twice.
        while let pair = tournament.current {
            tournament.discard(pair.low)
        }
        XCTAssertEqual(tournament.suggestedKeepIds, [3])
    }

    /// A group nobody judged — and a group that only ever drew, which is what
    /// happens to a genuine burst of near-identical photos — proposes exactly
    /// one keeper, not the whole thing. Thinning the group is the point of
    /// this screen; a tie is not a reason to keep everyone.
    func testAnUnjudgedGroupProposesOnlyTheBestRankedPhoto() {
        let tournament = CompareTournament(photoIds: [1, 2, 3])
        XCTAssertEqual(tournament.suggestedKeepIds, [1])
    }

    // MARK: - Orientation

    /// The same motif shot upright and wide is two photos worth having, not
    /// one plus a duplicate — so thinning „down to one" is per shape.
    func testEachOrientationKeepsItsOwnBestEvenWhenEverythingDrew() {
        let tournament = CompareTournament(
            photoIds: [1, 2, 3, 4],
            orientations: [
                1: .landscape, 2: .landscape, 3: .landscape, 4: .portrait,
            ]
        )
        // Nothing judged: one landscape (the first) and the single portrait.
        XCTAssertEqual(tournament.suggestedKeepIds, [1, 4])
    }

    /// Within one orientation the winner still wins outright — the split adds
    /// a floor per shape, it does not stop the thinning.
    func testAnOrientationWithAWinnerProposesOnlyTheWinner() {
        var tournament = CompareTournament(
            photoIds: [1, 2, 3],
            orientations: [1: .landscape, 2: .landscape, 3: .portrait]
        )
        // 1 loses to 2; 3 is the only portrait and never wins anything.
        while let pair = tournament.current {
            // Only settle the all-landscape pair decisively; everything else
            // draws, so the portrait keeps its floor rather than a win.
            if pair == CompareTournament.Pair(1, 2) {
                tournament.discard(1)
            } else {
                tournament.draw()
            }
        }
        XCTAssertEqual(tournament.suggestedKeepIds, [2, 3])
    }

    /// A photo the face scan has not measured has no orientation to be
    /// grouped by, and guessing one could hide the only frame of a shape —
    /// so „unknown" is a class of its own.
    func testUnmeasuredPhotosAreTheirOwnClass() {
        let tournament = CompareTournament(
            photoIds: [1, 2],
            orientations: [1: .landscape]
        )
        XCTAssertEqual(tournament.orientation(of: 2), .unknown)
        XCTAssertEqual(tournament.suggestedKeepIds, [1, 2])
    }

    /// Orientation comes off the dimensions the server sends, and a photo it
    /// has not measured yet decodes to `.unknown` rather than a guess.
    func testOrientationIsDerivedFromDimensions() {
        XCTAssertEqual(PhotoOrientation(width: 4032, height: 3024), .landscape)
        XCTAssertEqual(PhotoOrientation(width: 3024, height: 4032), .portrait)
        XCTAssertEqual(PhotoOrientation(width: 1000, height: 1000), .square)
        XCTAssertEqual(PhotoOrientation(width: nil, height: nil), .unknown)
        XCTAssertEqual(PhotoOrientation(width: 0, height: 100), .unknown)
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

    // MARK: - Going back into the comparison

    func testTheComparisonCanBeResumedAfterEndingItEarly() {
        var tournament = CompareTournament(photoIds: [1, 2, 3, 4])
        tournament.finishComparing()
        XCTAssertEqual(tournament.phase, .confirming)
        tournament.resumeComparing()
        XCTAssertEqual(tournament.phase, .comparing)
        XCTAssertNotNil(tournament.current)
    }

    /// Resuming continues; it does not start over. Pairs already judged stay
    /// judged, and their scores stand.
    func testResumingKeepsWhatWasAlreadyDecided() {
        var tournament = CompareTournament(photoIds: [1, 2, 3])
        let first = tournament.current!
        tournament.discard(first.low)
        let settledCount = tournament.comparisons
        tournament.finishComparing()
        tournament.resumeComparing()
        XCTAssertEqual(tournament.comparisons, settledCount)
        XCTAssertEqual(tournament.score(of: first.low), -1)
        XCTAssertNotEqual(tournament.current, first)
    }

    /// With every pair judged there is nothing to go back to, so resuming is a
    /// no-op rather than an empty comparison screen.
    func testResumingAFinishedTournamentDoesNothing() {
        var tournament = CompareTournament(photoIds: [1, 2])
        tournament.draw()
        XCTAssertFalse(tournament.hasUnsettledPairs)
        tournament.resumeComparing()
        XCTAssertEqual(tournament.phase, .confirming)
        XCTAssertNil(tournament.current)
    }

    /// A pair postponed with „später" is unjudged, so it is something to come
    /// back to.
    func testASkippedPairIsSomethingToResumeInto() {
        var tournament = CompareTournament(photoIds: [1, 2, 3])
        tournament.skip()
        tournament.finishComparing()
        XCTAssertTrue(tournament.hasUnsettledPairs)
        tournament.resumeComparing()
        XCTAssertEqual(tournament.phase, .comparing)
    }
}
