import CoreLocation
import XCTest
@testable import FKPhotosLib

/// When the collection may speak up, and what it says (§20.2, §6.4).
///
/// Everything here is a brake, and the brakes are the part worth
/// testing: a notice nobody asked for is the whole value of §20 and the
/// whole risk of it in the same mechanism.
final class TripIdeaNoticeTests: XCTestCase {

    private let munich = CLLocation(latitude: 48.14, longitude: 11.58)

    private func near(_ metres: Int, name: String = "Biergarten Mühlinsel", by: String? = nil) throws -> TripNearIdea {
        try JSONDecoder().decode(TripNearIdea.self, from: Data("""
        { "id": 1, "osmRef": "way:1", "name": "\(name)",
          "lat": 48.1, "lon": 11.5, "distanceM": \(metres),
          "category": "food", "dwellMinutes": 60, "note": null,
          "addedBy": \(by.map { "\"\($0)\"" } ?? "null"), "validTo": null }
        """.utf8))
    }

    // MARK: - The brake

    func testTheFirstAskIsAlwaysAllowed() {
        XCTAssertTrue(TripIdeaNotice.mayAsk(at: munich, last: nil))
    }

    func testNotTwiceWithinTheInterval() {
        // A phone that wakes six times crossing a town would otherwise
        // spend six entries' quiet week in the background, unseen.
        let now = Date()
        let far = CLLocation(latitude: 48.30, longitude: 11.58)
        XCTAssertFalse(TripIdeaNotice.mayAsk(
            at: far,
            last: (position: munich, at: now.addingTimeInterval(-60)),
            now: now,
        ))
    }

    func testNotFromTheSameBench() {
        // Sitting still is not new information. Without this, an entry
        // coming off quiet would eventually be offered at home.
        let now = Date()
        let nextDoor = CLLocation(latitude: 48.1405, longitude: 11.5805)
        XCTAssertFalse(TripIdeaNotice.mayAsk(
            at: nextDoor,
            last: (position: munich, at: now.addingTimeInterval(-4 * 60 * 60)),
            now: now,
        ))
    }

    func testTimeAndDistanceTogetherOpenTheGate() {
        let now = Date()
        let elsewhere = CLLocation(latitude: 48.30, longitude: 11.58)
        XCTAssertTrue(TripIdeaNotice.mayAsk(
            at: elsewhere,
            last: (position: munich, at: now.addingTimeInterval(-4 * 60 * 60)),
            now: now,
        ))
    }

    func testTheNoticeReachesLessFarThanTheScreenAsks() {
        // Unasked, "in der Nähe" has to mean near enough to act on —
        // otherwise it is an interruption about somewhere else.
        XCTAssertLessThan(TripIdeaNotice.radiusM, TripIdeaDefaults.nearbyRadiusM)
    }

    // MARK: - The sentence

    func testNothingNearbyIsNoNotification() throws {
        XCTAssertNil(TripIdeaNotice.sentence(for: []))
    }

    func testOneIdeaIsNamedWithWhoCollectedIt() throws {
        // §20's own form: "der Biergarten, den Anna gemerkt hat".
        let sentence = TripIdeaNotice.sentence(for: [try near(900, by: "Anna")])
        XCTAssertEqual(sentence?.body.contains("den Anna gemerkt hat"), true)
        XCTAssertEqual(sentence?.body.contains("900 m von hier"), true)
    }

    func testWithoutACollectorTheSentenceStillReads() throws {
        let sentence = TripIdeaNotice.sentence(for: [try near(400)])
        XCTAssertEqual(sentence?.body.hasPrefix("Biergarten Mühlinsel — 400 m"), true)
    }

    func testTheNearestOneIsTheOneNamed() throws {
        let sentence = TripIdeaNotice.sentence(for: [
            try near(1800, name: "Weiter weg"),
            try near(300, name: "Gleich hier"),
        ])
        XCTAssertEqual(sentence?.body.hasPrefix("Gleich hier"), true)
    }

    func testTheOthersAreCountedRatherThanListed() throws {
        // A notification that lists four is a screen pretending to be a
        // sentence.
        let two = TripIdeaNotice.sentence(for: [try near(300), try near(800, name: "B")])
        XCTAssertEqual(two?.body.contains("Eine weitere Idee"), true)

        let four = TripIdeaNotice.sentence(for: [
            try near(300), try near(800, name: "B"),
            try near(900, name: "C"), try near(1000, name: "D"),
        ])
        XCTAssertEqual(four?.body.contains("3 weitere Ideen"), true)
    }

    // MARK: - The switch

    func testItIsOffUntilSomebodySaysSo() {
        let store = UserDefaults(suiteName: "ideas.notice.test.off")!
        store.removePersistentDomain(forName: "ideas.notice.test.off")
        XCTAssertFalse(TripIdeaNoticePreferences.isEnabled(store))
    }

    func testSwitchingOffForgetsWhereItLastAsked() {
        // Switching on again weeks later should not inherit a brake
        // from a different city.
        let name = "ideas.notice.test.forget"
        let store = UserDefaults(suiteName: name)!
        store.removePersistentDomain(forName: name)

        TripIdeaNoticePreferences.setEnabled(true, store)
        TripIdeaNoticePreferences.rememberAsk(at: munich, store)
        XCTAssertNotNil(TripIdeaNoticePreferences.lastAsk(store))

        TripIdeaNoticePreferences.setEnabled(false, store)
        XCTAssertNil(TripIdeaNoticePreferences.lastAsk(store))
    }

    func testWhatItRemembersComesBack() {
        let name = "ideas.notice.test.memory"
        let store = UserDefaults(suiteName: name)!
        store.removePersistentDomain(forName: name)

        let when = Date(timeIntervalSince1970: 1_800_000_000)
        TripIdeaNoticePreferences.rememberAsk(at: munich, now: when, store)

        let last = TripIdeaNoticePreferences.lastAsk(store)
        XCTAssertEqual(last?.at, when)
        XCTAssertEqual(last?.position.distance(from: munich) ?? 1, 0, accuracy: 1)
    }
}
