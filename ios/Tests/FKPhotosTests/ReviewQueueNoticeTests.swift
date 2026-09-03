import XCTest
@testable import FKPhotosLib

/// The pure rules behind every entry point into the group review: what the
/// badge says, what the banner says, and when a growth is worth a
/// notification (#968).
final class ReviewQueueNoticeTests: XCTestCase {

    // MARK: - Badge

    func testNoBadgeWhenNotLoadedOrZero() {
        XCTAssertNil(ReviewQueueNotice.badgeText(nil))
        XCTAssertNil(ReviewQueueNotice.badgeText(0))
    }

    func testTheBadgeShowsTheExactCount() {
        XCTAssertEqual(ReviewQueueNotice.badgeText(1), "1")
        XCTAssertEqual(ReviewQueueNotice.badgeText(42), "42")
    }

    func testTheBadgeCapsAtNinetyNine() {
        XCTAssertEqual(ReviewQueueNotice.badgeText(100), "99+")
        XCTAssertEqual(ReviewQueueNotice.badgeText(99), "99")
    }

    // MARK: - Subtitle / banner text

    func testSubtitleDistinguishesNotLoadedFromEmpty() {
        XCTAssertEqual(ReviewQueueNotice.subtitle(nil), "Ähnliche Fotos aussortieren")
        XCTAssertEqual(ReviewQueueNotice.subtitle(0), "Nichts offen — alles durchgesehen")
    }

    func testSubtitlePluralizesCorrectly() {
        XCTAssertEqual(ReviewQueueNotice.subtitle(1), "1 Gruppe wartet")
        XCTAssertEqual(ReviewQueueNotice.subtitle(2), "2 Gruppen warten")
    }

    func testBannerTitlePluralizes() {
        XCTAssertEqual(ReviewQueueNotice.bannerTitle(1), "1 Gruppe wartet auf Review")
        XCTAssertEqual(ReviewQueueNotice.bannerTitle(5), "5 Gruppen warten auf Review")
    }

    // MARK: - Notification gating

    /// The first read after install is a measurement, not news — a pile that
    /// was always there must not greet a new user as an event.
    func testNoPreviousCountMeansNoNotification() {
        XCTAssertFalse(ReviewQueueNotice.shouldNotify(previous: nil, current: 5))
    }

    func testAShrinkingQueueDoesNotNotify() {
        XCTAssertFalse(ReviewQueueNotice.shouldNotify(previous: 5, current: 3))
    }

    func testAnUnchangedQueueDoesNotNotify() {
        XCTAssertFalse(ReviewQueueNotice.shouldNotify(previous: 5, current: 5))
    }

    func testAGrowingQueueNotifies() {
        XCTAssertTrue(ReviewQueueNotice.shouldNotify(previous: 2, current: 5))
    }

    func testGrowingFromZeroStillNotifies() {
        XCTAssertTrue(ReviewQueueNotice.shouldNotify(previous: 0, current: 3))
    }

    func testNotificationBodyNamesTheNewArrivalsAndTheTotal() {
        let body = ReviewQueueNotice.notificationBody(previous: 2, current: 5)
        XCTAssertEqual(body, "3 neue Gruppen ähnlicher Fotos — insgesamt 5 offen.")
    }

    func testNotificationBodySingularForOneNewGroup() {
        let body = ReviewQueueNotice.notificationBody(previous: 4, current: 5)
        XCTAssertEqual(body, "1 neue Gruppe ähnlicher Fotos — insgesamt 5 offen.")
    }
}
