import CoreLocation
import XCTest
@testable import FKPhotosLib

/// Locks the **auto-start suggestion contract** (`docs/ios-trip-mode.md` §9.2):
/// only ever a suggestion, raised from photo GPS rather than live location, and
/// only when the photos show a stay that is both far from home and long enough
/// to be a trip rather than an outing. The PhotoKit enumeration and the
/// notification plumbing (`TripAutoStartMonitor`) can't run in CI; this is its
/// pure decision core.
final class TripAutoStartHeuristicTests: XCTestCase {

    private let home = CLLocationCoordinate2D(latitude: 48.14, longitude: 11.58)
    private let start = Date(timeIntervalSince1970: 1_000_000)

    /// Roughly 300 km north of home — comfortably past the 100 km threshold.
    private var farAway: (lat: Double, lon: Double) { (home.latitude + 2.7, home.longitude) }

    private func sample(_ offset: TimeInterval, far: Bool = true) -> TripPhotoSample {
        TripPhotoSample(
            date: start.addingTimeInterval(offset),
            latitude: far ? farAway.lat : home.latitude,
            longitude: far ? farAway.lon : home.longitude
        )
    }

    /// "Now" just after the last sample of a full-span cluster, so recency
    /// never accidentally decides a test that is about something else.
    private func now(after offset: TimeInterval) -> Date {
        start.addingTimeInterval(offset + 60)
    }

    // MARK: - The actual trigger

    func testFarAwayClusterSpanningTheMinimumSuggests() {
        let span = TripAutoStartPreferences.minimumSpan
        let outcome = TripAutoStartHeuristic.evaluate(
            samples: [sample(0), sample(span)], home: home, now: now(after: span)
        )
        XCTAssertNotNil(outcome)
        XCTAssertEqual(outcome?.travellingSince, start, "The earliest away photo dates the trip")
    }

    func testOutcomeReportsTheMostRecentPosition() {
        let span = TripAutoStartPreferences.minimumSpan
        // Second photo a little further north than the first.
        let later = TripPhotoSample(
            date: start.addingTimeInterval(span), latitude: farAway.lat + 0.5, longitude: farAway.lon
        )
        let outcome = TripAutoStartHeuristic.evaluate(
            samples: [sample(0), later], home: home, now: now(after: span)
        )
        XCTAssertEqual(outcome?.latitude, later.latitude, "Where the user is now, not where they arrived")
        XCTAssertEqual(
            outcome?.regionCell,
            TripRegionGrid.cellKey(latitude: later.latitude, longitude: later.longitude)
        )
    }

    // MARK: - Distance

    func testPhotosNearHomeNeverSuggest() {
        let span = TripAutoStartPreferences.minimumSpan
        let outcome = TripAutoStartHeuristic.evaluate(
            samples: [sample(0, far: false), sample(span, far: false)],
            home: home,
            now: now(after: span)
        )
        XCTAssertNil(outcome, "A long day at home is not a trip")
    }

    func testNearbyPhotosDoNotPadTheSpanOfAFarAwayCluster() {
        // One far-away photo, plus a photo at home six hours earlier. The span
        // must be measured across the *away* photos only — otherwise a single
        // distant shot would inherit the timeline of unrelated home photos.
        let span = TripAutoStartPreferences.minimumSpan
        let outcome = TripAutoStartHeuristic.evaluate(
            samples: [sample(0, far: false), sample(span)], home: home, now: now(after: span)
        )
        XCTAssertNil(outcome)
    }

    // MARK: - Span and burst handling

    func testSingleFarAwayPhotoDoesNotSuggest() {
        let outcome = TripAutoStartHeuristic.evaluate(
            samples: [sample(0)], home: home, now: now(after: 0)
        )
        XCTAssertNil(outcome, "One photo is a stop, not a stay")
    }

    func testBurstAtOneInstantDoesNotSuggest() {
        // Ten shots sharing a timestamp: a layover burst, not six hours away.
        let burst = (0..<10).map { _ in sample(0) }
        let outcome = TripAutoStartHeuristic.evaluate(
            samples: burst, home: home, now: now(after: 0)
        )
        XCTAssertNil(outcome, "Distinct instants matter, not photo count")
    }

    func testClusterShorterThanTheMinimumSpanDoesNotSuggest() {
        let span = TripAutoStartPreferences.minimumSpan - 1
        let outcome = TripAutoStartHeuristic.evaluate(
            samples: [sample(0), sample(span)], home: home, now: now(after: span)
        )
        XCTAssertNil(outcome)
    }

    // MARK: - Recency

    func testStaleClusterDoesNotSuggest() {
        // A qualifying cluster, but the user has since come home — the newest
        // away photo is older than the recency window.
        let span = TripAutoStartPreferences.minimumSpan
        let stale = start.addingTimeInterval(
            span + TripAutoStartPreferences.recencyWindow + 60
        )
        let outcome = TripAutoStartHeuristic.evaluate(
            samples: [sample(0), sample(span)], home: home, now: stale
        )
        XCTAssertNil(outcome, "Last week's holiday must not resurface as a suggestion")
    }

    // MARK: - Degenerate input

    func testNoSamplesDoesNotSuggest() {
        XCTAssertNil(
            TripAutoStartHeuristic.evaluate(samples: [], home: home, now: start)
        )
    }

    // MARK: - Cooldown

    func testCooldownBlocksARepeatSuggestion() {
        let now = start.addingTimeInterval(TripAutoStartPreferences.suggestionCooldown - 1)
        XCTAssertTrue(
            TripAutoStartHeuristic.isWithinCooldown(lastSuggestionAt: start, now: now)
        )
    }

    func testCooldownExpires() {
        let now = start.addingTimeInterval(TripAutoStartPreferences.suggestionCooldown + 1)
        XCTAssertFalse(
            TripAutoStartHeuristic.isWithinCooldown(lastSuggestionAt: start, now: now)
        )
    }

    func testNoPreviousSuggestionIsNotInCooldown() {
        XCTAssertFalse(
            TripAutoStartHeuristic.isWithinCooldown(lastSuggestionAt: nil, now: start)
        )
    }
}
