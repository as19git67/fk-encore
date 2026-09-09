import CoreLocation
import XCTest
@testable import FKPhotosLib

/// When a last known fix may answer "where are we now?" (§5).
///
/// This is the rule behind the bug where "Umplanen" said there was no
/// location on the first press and worked on the second: a fix existed,
/// it was simply never asked for.
final class TripLocationFreshnessTests: XCTestCase {

    private func fix(accuracy: CLLocationAccuracy, ageSeconds: TimeInterval,
                     now: Date = Date()) -> CLLocation {
        CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: 48.14, longitude: 11.58),
            altitude: 0,
            horizontalAccuracy: accuracy,
            verticalAccuracy: -1,
            timestamp: now.addingTimeInterval(-ageSeconds))
    }

    func testAFreshAccurateFixIsGoodEnough() {
        let now = Date()
        XCTAssertTrue(TripLocationFreshness.isUsable(
            fix(accuracy: 12, ageSeconds: 5, now: now), now: now))
    }

    func testAStaleFixIsNotWhereYouAreNow() {
        // Ten minutes ago is a different question — on foot that is
        // several street corners.
        let now = Date()
        XCTAssertFalse(TripLocationFreshness.isUsable(
            fix(accuracy: 10, ageSeconds: 600, now: now), now: now))
    }

    func testAVagueFixIsRefused() {
        // A kilometre out would rearrange the afternoon around the
        // wrong corner.
        let now = Date()
        XCTAssertFalse(TripLocationFreshness.isUsable(
            fix(accuracy: 1500, ageSeconds: 5, now: now), now: now))
    }

    func testAnInvalidFixIsNotAPerfectOne() {
        // CoreLocation reports a negative accuracy for a fix it could
        // not determine — the one value that must never read as exact.
        let now = Date()
        XCTAssertFalse(TripLocationFreshness.isUsable(
            fix(accuracy: -1, ageSeconds: 1, now: now), now: now))
    }

    func testAFixFromTheFutureIsNotTrusted() {
        let now = Date()
        XCTAssertFalse(TripLocationFreshness.isUsable(
            fix(accuracy: 10, ageSeconds: -30, now: now), now: now))
    }
}
