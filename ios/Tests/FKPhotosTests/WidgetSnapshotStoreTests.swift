import XCTest
@testable import FKPhotosLib

/// What the home-screen widgets are shown (#764) — the main app writes,
/// the extension only ever reads, and these tests stand in for both
/// sides without an actual widget process.
final class WidgetSnapshotStoreTests: XCTestCase {

    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        suiteName = "WidgetSnapshotStoreTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
    }

    private func recap(
        id: Int, kind: String, title: String, dismissed: Bool = false
    ) -> RecapSummary {
        RecapSummary(
            id: id, kind: kind, title: title, subtitle: "Untertitel \(id)",
            cover_photo_id: nil, period_start: nil, period_end: nil, photo_count: 3,
            created_at: "2027-07-01T10:00:00Z",
            dismissed_at: dismissed ? "2027-07-02T10:00:00Z" : nil,
            seen_at: nil,
        )
    }

    private func feedItem(id: Int, ownerName: String?, albumName: String?) -> FeedPhotoItem {
        FeedPhotoItem(
            photoId: id, filename: "img\(id).heic", width: nil, height: nil, description: nil,
            takenAt: nil, lastActivityAt: "2027-07-01T12:00:00Z",
            album: albumName.map { FeedAlbumRef(id: 1, name: $0) },
            owner: FeedOwnerRef(id: 2, name: ownerName),
            likeCount: 0, likedByMe: false, commentCount: 0, latestComment: nil,
        )
    }

    func testTheLatestUndismissedRecapWinsOverAnOlderDismissedOne() {
        let recaps = [
            recap(id: 1, kind: "trip", title: "Reise", dismissed: true),
            recap(id: 2, kind: "person", title: "Familie"),
        ]
        WidgetSnapshotStore.updateFromRecaps(recaps, defaults: defaults)

        let latest = WidgetSnapshotStore.loadLatestRecap(defaults: defaults)
        XCTAssertEqual(latest?.recapId, 2)
        XCTAssertEqual(latest?.title, "Familie")
    }

    func testFallsBackToTheNewestRecapWhenNoneIsUndismissed() {
        let recaps = [recap(id: 1, kind: "trip", title: "Reise", dismissed: true)]
        WidgetSnapshotStore.updateFromRecaps(recaps, defaults: defaults)

        XCTAssertEqual(WidgetSnapshotStore.loadLatestRecap(defaults: defaults)?.recapId, 1)
    }

    func testOnThisDayIsOnlySetWhenAnUndismissedOneExists() {
        WidgetSnapshotStore.updateFromRecaps(
            [recap(id: 3, kind: "on_this_day", title: "Vor 3 Jahren")], defaults: defaults
        )
        XCTAssertEqual(WidgetSnapshotStore.loadOnThisDay(defaults: defaults)?.recapId, 3)

        // Dismissed: the widget has nothing to show, not a stale memory.
        WidgetSnapshotStore.updateFromRecaps(
            [recap(id: 3, kind: "on_this_day", title: "Vor 3 Jahren", dismissed: true)], defaults: defaults
        )
        XCTAssertNil(WidgetSnapshotStore.loadOnThisDay(defaults: defaults))
    }

    func testOnThisDayIgnoresARecapOfAnotherKind() {
        WidgetSnapshotStore.updateFromRecaps(
            [recap(id: 4, kind: "trip", title: "Reise")], defaults: defaults
        )
        XCTAssertNil(WidgetSnapshotStore.loadOnThisDay(defaults: defaults))
    }

    func testTheNewestFeedItemIsWhatTheWidgetShows() {
        let items = [
            feedItem(id: 10, ownerName: "Anna", albumName: "Urlaub"),
            feedItem(id: 9, ownerName: "Ben", albumName: nil),
        ]
        WidgetSnapshotStore.updateFromFeed(items, defaults: defaults)

        let snapshot = WidgetSnapshotStore.loadRecentFeed(defaults: defaults)
        XCTAssertEqual(snapshot?.photoId, 10)
        XCTAssertEqual(snapshot?.ownerName, "Anna")
        XCTAssertEqual(snapshot?.albumName, "Urlaub")
    }

    func testAnEmptyFeedClearsAnyPreviousSnapshot() {
        WidgetSnapshotStore.updateFromFeed([feedItem(id: 1, ownerName: "Anna", albumName: nil)], defaults: defaults)
        XCTAssertNotNil(WidgetSnapshotStore.loadRecentFeed(defaults: defaults))

        WidgetSnapshotStore.updateFromFeed([], defaults: defaults)
        XCTAssertNil(WidgetSnapshotStore.loadRecentFeed(defaults: defaults))
    }
}
