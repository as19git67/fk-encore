import CoreLocation
import XCTest
@testable import FKPhotosLib

/// Locks the **auto-end suggestion contract**: never automatic (only ever a
/// `shouldSuggest` flag the caller turns into a prompt), fires once a
/// continuous stay at home has held for the grace period, and backs off for a
/// cooldown afterwards so leaving-and-returning briefly doesn't re-ask
/// immediately. The CoreLocation plumbing (`TripAutoEndMonitor`) can't run in
/// CI; this is its pure decision core.
final class TripAutoEndHeuristicTests: XCTestCase {

    private let home = CLLocationCoordinate2D(latitude: 48.14, longitude: 11.58)
    private let start = Date(timeIntervalSince1970: 1_000_000)

    // MARK: - isAtHome

    func testWithinRadiusIsAtHome() {
        // ~1 km north of home, inside the 2 km radius.
        let nearby = CLLocationCoordinate2D(latitude: home.latitude + 0.009, longitude: home.longitude)
        XCTAssertTrue(TripAutoEndHeuristic.isAtHome(nearby, home: home))
    }

    func testOutsideRadiusIsNotAtHome() {
        let munich = CLLocationCoordinate2D(latitude: 48.14, longitude: 11.58)
        let farAway = CLLocationCoordinate2D(latitude: munich.latitude + 1, longitude: munich.longitude)
        XCTAssertFalse(TripAutoEndHeuristic.isAtHome(farAway, home: munich))
    }

    // MARK: - evaluate: away resets the candidate

    func testAwayFromHomeResetsCandidate() {
        let decision = TripAutoEndHeuristic.evaluate(
            candidateSince: start, lastSuggestionAt: nil, isAtHome: false, now: start.addingTimeInterval(60)
        )
        XCTAssertNil(decision.candidateSince)
        XCTAssertFalse(decision.shouldSuggest)
    }

    // MARK: - evaluate: arriving starts the clock, but doesn't suggest yet

    func testFirstArrivalStartsCandidateWithoutSuggesting() {
        let decision = TripAutoEndHeuristic.evaluate(
            candidateSince: nil, lastSuggestionAt: nil, isAtHome: true, now: start
        )
        XCTAssertEqual(decision.candidateSince, start, "First sample at home becomes the candidate start")
        XCTAssertFalse(decision.shouldSuggest)
    }

    func testStayingHomeBelowGraceDoesNotSuggest() {
        let decision = TripAutoEndHeuristic.evaluate(
            candidateSince: start,
            lastSuggestionAt: nil,
            isAtHome: true,
            now: start.addingTimeInterval(TripAutoEndPreferences.homeArrivalGrace - 1)
        )
        XCTAssertEqual(decision.candidateSince, start)
        XCTAssertFalse(decision.shouldSuggest)
    }

    // MARK: - evaluate: the actual trigger

    func testStayingHomePastGraceSuggests() {
        let decision = TripAutoEndHeuristic.evaluate(
            candidateSince: start,
            lastSuggestionAt: nil,
            isAtHome: true,
            now: start.addingTimeInterval(TripAutoEndPreferences.homeArrivalGrace)
        )
        XCTAssertTrue(decision.shouldSuggest)
    }

    // MARK: - evaluate: cooldown

    func testRecentSuggestionSuppressesANewOne() {
        let now = start.addingTimeInterval(TripAutoEndPreferences.homeArrivalGrace + 100)
        let decision = TripAutoEndHeuristic.evaluate(
            candidateSince: start,
            lastSuggestionAt: now.addingTimeInterval(-60),
            isAtHome: true,
            now: now
        )
        XCTAssertFalse(decision.shouldSuggest, "A suggestion raised a minute ago is still within the cooldown")
    }

    func testSuggestionAfterCooldownFiresAgain() {
        let now = start.addingTimeInterval(TripAutoEndPreferences.homeArrivalGrace + 100)
        let decision = TripAutoEndHeuristic.evaluate(
            candidateSince: start,
            lastSuggestionAt: now.addingTimeInterval(-TripAutoEndPreferences.suggestionCooldown - 1),
            isAtHome: true,
            now: now
        )
        XCTAssertTrue(decision.shouldSuggest)
    }
}
