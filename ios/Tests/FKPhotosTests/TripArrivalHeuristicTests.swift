import XCTest
@testable import FKPhotosLib

/// When to offer a redistribution, and — far more often — when not to
/// (§7.1).
///
/// "Angeboten, nicht durchgeführt" is the concept's rule, and the risk
/// this guards is the other one: a suggestion that fires too readily is
/// a nag, a nagged traveller turns the feature off, and then the case it
/// exists for — the evening about to be lost — never fires either. So
/// most of these tests are about staying quiet.
final class TripArrivalHeuristicTests: XCTestCase {

    /// A 210-minute block, half gone.
    private func halfway(
        work: Int,
        stops: Int,
        alreadySuggested: Bool = false,
    ) -> TripArrivalHeuristic.Situation {
        .init(
            elapsedMinutes: 105,
            remainingMinutes: 105,
            remainingWorkMinutes: work,
            remainingStops: stops,
            alreadySuggested: alreadySuggested,
        )
    }

    private func isOffer(_ verdict: TripArrivalHeuristic.Verdict) -> Bool {
        if case .offer = verdict { return true }
        return false
    }

    // MARK: - When it speaks

    func testOffersWhenWhatIsLeftWillNotFit() {
        // 150 minutes of stops in 105 minutes of block.
        let verdict = TripArrivalHeuristic.evaluate(halfway(work: 150, stops: 2))
        XCTAssertTrue(isOffer(verdict))
    }

    func testTheSentenceSaysBothNumbers() {
        // "Umplanen?" alone is a demand; the numbers make it a case the
        // traveller can agree or disagree with.
        guard case let .offer(reason) = TripArrivalHeuristic.evaluate(halfway(work: 150, stops: 2))
        else { return XCTFail("expected an offer") }
        XCTAssertTrue(reason.contains("150"), reason)
        XCTAssertTrue(reason.contains("105"), reason)
        XCTAssertTrue(reason.contains("2"), reason)
    }

    func testASingleRemainingStopReadsAsOne() {
        guard case let .offer(reason) = TripArrivalHeuristic.evaluate(halfway(work: 160, stops: 1))
        else { return XCTFail("expected an offer") }
        XCTAssertTrue(reason.contains("letzte Stopp"), reason)
    }

    // MARK: - When it stays quiet

    func testSaysNothingWhenTheRestFits() {
        XCTAssertEqual(TripArrivalHeuristic.evaluate(halfway(work: 90, stops: 2)), .quiet)
    }

    func testSaysNothingForAnOverrunInsideTheNoise() {
        // A straight-line walking estimate cannot tell seven minutes
        // from none. Prompting on that is prompting on nothing.
        XCTAssertEqual(TripArrivalHeuristic.evaluate(halfway(work: 112, stops: 2)), .quiet)
    }

    func testSaysNothingEarlyInTheBlock() {
        // A quarter in, the estimates are least reliable and the group
        // may simply be walking fast — even when the shortfall is huge.
        let early = TripArrivalHeuristic.Situation(
            elapsedMinutes: 52,
            remainingMinutes: 158,
            remainingWorkMinutes: 300,
            remainingStops: 3,
            alreadySuggested: false,
        )
        XCTAssertEqual(TripArrivalHeuristic.evaluate(early), .quiet)
    }

    func testSaysNothingWhenThereIsNoRoomLeftToRedistributeInto() {
        let nearlyOver = TripArrivalHeuristic.Situation(
            elapsedMinutes: 200,
            remainingMinutes: 10,
            remainingWorkMinutes: 90,
            remainingStops: 2,
            alreadySuggested: false,
        )
        XCTAssertEqual(TripArrivalHeuristic.evaluate(nearlyOver), .quiet)
    }

    func testAsksOncePerBlockAndNotAgain() {
        XCTAssertEqual(
            TripArrivalHeuristic.evaluate(halfway(work: 150, stops: 2, alreadySuggested: true)),
            .quiet,
        )
    }

    func testSaysNothingWhenNothingIsLeftToDo() {
        XCTAssertEqual(TripArrivalHeuristic.evaluate(halfway(work: 0, stops: 0)), .quiet)
    }

    func testSurvivesABlockWithNoTimeAtAll() {
        let empty = TripArrivalHeuristic.Situation(
            elapsedMinutes: 0,
            remainingMinutes: 0,
            remainingWorkMinutes: 60,
            remainingStops: 2,
            alreadySuggested: false,
        )
        XCTAssertEqual(TripArrivalHeuristic.evaluate(empty), .quiet)
    }

    // MARK: - The boundary

    func testTheToleranceIsAFloorNotACeiling() {
        // Exactly at the tolerance is worth saying; one minute under is
        // not. Pinning the boundary keeps a later tweak honest.
        XCTAssertTrue(isOffer(TripArrivalHeuristic.evaluate(halfway(work: 115, stops: 2))))
        XCTAssertEqual(TripArrivalHeuristic.evaluate(halfway(work: 114, stops: 2)), .quiet)
    }

    func testHalfGoneIsEnoughButLessIsNot() {
        let half = TripArrivalHeuristic.Situation(
            elapsedMinutes: 105, remainingMinutes: 105,
            remainingWorkMinutes: 150, remainingStops: 2, alreadySuggested: false,
        )
        let justUnder = TripArrivalHeuristic.Situation(
            elapsedMinutes: 104, remainingMinutes: 106,
            remainingWorkMinutes: 150, remainingStops: 2, alreadySuggested: false,
        )
        XCTAssertTrue(isOffer(TripArrivalHeuristic.evaluate(half)))
        XCTAssertEqual(TripArrivalHeuristic.evaluate(justUnder), .quiet)
    }
}
