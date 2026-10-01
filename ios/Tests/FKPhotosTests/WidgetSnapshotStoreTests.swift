import XCTest
import UIKit
@testable import FKPhotosLib

/// What the home-screen widgets are shown (#764) — the main app writes,
/// the extension only ever reads, and these tests stand in for both
/// sides without an actual widget process.
final class WidgetSnapshotStoreTests: XCTestCase {

    private var defaults: UserDefaults!
    private var suiteName: String!
    private var images: WidgetImageStore!

    override func setUp() {
        suiteName = "WidgetSnapshotStoreTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
        images = WidgetImageStore(
            directory: FileManager.default.temporaryDirectory.appendingPathComponent(suiteName, isDirectory: true)
        )
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        try? FileManager.default.removeItem(at: images.directory)
    }

    private func recap(
        id: Int, kind: String, title: String, dismissed: Bool = false, coverPhotoId: Int? = nil
    ) -> RecapSummary {
        RecapSummary(
            id: id, kind: kind, title: title, subtitle: "Untertitel \(id)",
            cover_photo_id: coverPhotoId, period_start: nil, period_end: nil, photo_count: 3,
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

    // MARK: - Images

    /// A tiny real JPEG: `WidgetImageStore` decodes what it is given, so
    /// arbitrary bytes would (rightly) be refused.
    private func jpeg() throws -> Data {
        try XCTUnwrap(UIImage(systemName: "photo")?.jpegData(compressionQuality: 0.5))
    }

    /// Records which filenames were asked for and answers with `jpeg()`.
    private final class Fetches: @unchecked Sendable {
        var filenames: [String] = []
    }

    func testTheRecapWidgetsGetTheirCoverPhotoAfterTheText() async throws {
        let bytes = try jpeg()
        let fetches = Fetches()
        WidgetSnapshotStore.updateFromRecaps(
            [recap(id: 5, kind: "on_this_day", title: "Vor 5 Jahren", coverPhotoId: 50)], defaults: defaults
        )
        // Text first, no photo yet — the widget is never behind the app.
        XCTAssertNil(WidgetSnapshotStore.loadLatestRecap(defaults: defaults)?.imageFile)

        await WidgetSnapshotStore.updateRecapImages(
            coverFilenames: [50: "2027/2027-07/cover.heic"], defaults: defaults, images: images
        ) { name in
            fetches.filenames.append(name)
            return bytes
        }

        let latest = WidgetSnapshotStore.loadLatestRecap(defaults: defaults)
        let onThisDay = WidgetSnapshotStore.loadOnThisDay(defaults: defaults)
        XCTAssertEqual(latest?.imageFile, "LatestRecapWidget-50.jpg")
        XCTAssertEqual(onThisDay?.imageFile, "OnThisDayWidget-50.jpg")
        XCTAssertNotNil(images.image(named: latest?.imageFile))
        XCTAssertNotNil(images.image(named: onThisDay?.imageFile))
        XCTAssertEqual(fetches.filenames, ["2027/2027-07/cover.heic", "2027/2027-07/cover.heic"])
    }

    func testTheSameCoverIsNotDownloadedTwice() async throws {
        let bytes = try jpeg()
        let fetches = Fetches()
        WidgetSnapshotStore.updateFromRecaps(
            [recap(id: 5, kind: "trip", title: "Reise", coverPhotoId: 50)], defaults: defaults
        )
        await WidgetSnapshotStore.updateRecapImages(
            coverFilenames: [50: "a.jpg"], defaults: defaults, images: images
        ) { name in fetches.filenames.append(name); return bytes }
        XCTAssertEqual(fetches.filenames.count, 1)

        // The list reloads with the same recap on top: the text is
        // rewritten, the photo stays, nothing is fetched again.
        WidgetSnapshotStore.updateFromRecaps(
            [recap(id: 5, kind: "trip", title: "Reise", coverPhotoId: 50)], defaults: defaults
        )
        XCTAssertEqual(WidgetSnapshotStore.loadLatestRecap(defaults: defaults)?.imageFile, "LatestRecapWidget-50.jpg")
        await WidgetSnapshotStore.updateRecapImages(
            coverFilenames: [50: "a.jpg"], defaults: defaults, images: images
        ) { name in fetches.filenames.append(name); return bytes }
        XCTAssertEqual(fetches.filenames.count, 1)
    }

    func testANewRecapDoesNotInheritTheOldPhoto() async throws {
        let bytes = try jpeg()
        WidgetSnapshotStore.updateFromRecaps(
            [recap(id: 5, kind: "trip", title: "Reise", coverPhotoId: 50)], defaults: defaults
        )
        await WidgetSnapshotStore.updateRecapImages(
            coverFilenames: [50: "a.jpg"], defaults: defaults, images: images
        ) { _ in bytes }

        WidgetSnapshotStore.updateFromRecaps(
            [recap(id: 6, kind: "person", title: "Familie", coverPhotoId: 60)], defaults: defaults
        )
        XCTAssertNil(WidgetSnapshotStore.loadLatestRecap(defaults: defaults)?.imageFile)

        await WidgetSnapshotStore.updateRecapImages(
            coverFilenames: [60: "b.jpg"], defaults: defaults, images: images
        ) { _ in bytes }
        XCTAssertEqual(WidgetSnapshotStore.loadLatestRecap(defaults: defaults)?.imageFile, "LatestRecapWidget-60.jpg")
        // Only ever one file per widget on disk.
        XCTAssertFalse(images.contains("LatestRecapWidget-50.jpg"))
        XCTAssertTrue(images.contains("LatestRecapWidget-60.jpg"))
    }

    func testAFailedDownloadLeavesTheTextAndNoPhoto() async {
        struct Offline: Error {}
        WidgetSnapshotStore.updateFromRecaps(
            [recap(id: 5, kind: "trip", title: "Reise", coverPhotoId: 50)], defaults: defaults
        )
        await WidgetSnapshotStore.updateRecapImages(
            coverFilenames: [50: "a.jpg"], defaults: defaults, images: images
        ) { _ in throw Offline() }

        let latest = WidgetSnapshotStore.loadLatestRecap(defaults: defaults)
        XCTAssertEqual(latest?.title, "Reise")
        XCTAssertNil(latest?.imageFile)
    }

    func testARecapWithoutACoverGetsNoPhoto() async throws {
        let bytes = try jpeg()
        let fetches = Fetches()
        WidgetSnapshotStore.updateFromRecaps(
            [recap(id: 5, kind: "trip", title: "Reise")], defaults: defaults
        )
        await WidgetSnapshotStore.updateRecapImages(
            coverFilenames: [:], defaults: defaults, images: images
        ) { name in fetches.filenames.append(name); return bytes }
        XCTAssertTrue(fetches.filenames.isEmpty)
        XCTAssertNil(WidgetSnapshotStore.loadLatestRecap(defaults: defaults)?.imageFile)
    }

    func testTheFeedWidgetGetsItsPhoto() async throws {
        let bytes = try jpeg()
        WidgetSnapshotStore.updateFromFeed([feedItem(id: 10, ownerName: "Anna", albumName: nil)], defaults: defaults)
        await WidgetSnapshotStore.updateFeedImage(
            filename: "img10.heic", defaults: defaults, images: images
        ) { _ in bytes }

        let snapshot = WidgetSnapshotStore.loadRecentFeed(defaults: defaults)
        XCTAssertEqual(snapshot?.imageFile, "RecentFeedWidget-10.jpg")
        XCTAssertNotNil(images.image(named: snapshot?.imageFile))

        // A different newest item: the old photo is not shown for it.
        WidgetSnapshotStore.updateFromFeed([feedItem(id: 11, ownerName: "Ben", albumName: nil)], defaults: defaults)
        XCTAssertNil(WidgetSnapshotStore.loadRecentFeed(defaults: defaults)?.imageFile)
    }

    func testSigningOutLeavesNothingForTheNextAccount() async throws {
        let bytes = try jpeg()
        WidgetSnapshotStore.updateFromRecaps(
            [recap(id: 5, kind: "on_this_day", title: "Vor 5 Jahren", coverPhotoId: 50)], defaults: defaults
        )
        await WidgetSnapshotStore.updateRecapImages(
            coverFilenames: [50: "cover.heic"], defaults: defaults, images: images
        ) { _ in bytes }
        WidgetSnapshotStore.updateFromFeed([feedItem(id: 10, ownerName: "Anna", albumName: "Urlaub")], defaults: defaults)
        await WidgetSnapshotStore.updateFeedImage(
            filename: "img10.heic", defaults: defaults, images: images
        ) { _ in bytes }
        let files = [
            WidgetSnapshotStore.loadOnThisDay(defaults: defaults)?.imageFile,
            WidgetSnapshotStore.loadLatestRecap(defaults: defaults)?.imageFile,
            WidgetSnapshotStore.loadRecentFeed(defaults: defaults)?.imageFile,
        ].compactMap { $0 }
        XCTAssertEqual(files.count, 3)

        WidgetSnapshotStore.clearAll(defaults: defaults, images: images)

        XCTAssertNil(WidgetSnapshotStore.loadOnThisDay(defaults: defaults))
        XCTAssertNil(WidgetSnapshotStore.loadLatestRecap(defaults: defaults))
        XCTAssertNil(WidgetSnapshotStore.loadRecentFeed(defaults: defaults))
        for file in files {
            XCTAssertFalse(images.contains(file), "\(file) survived sign-out")
        }
    }

    func testASnapshotWrittenBeforeImagesExistedStillDecodes() throws {
        // What #764 stored: no `coverPhotoId`, no `imageFile`.
        let legacy = Data("""
        {"title":"Reise","subtitle":null,"recapId":5,"isOnThisDay":false}
        """.utf8)
        defaults.set(legacy, forKey: "widgets.latestRecap")

        let latest = WidgetSnapshotStore.loadLatestRecap(defaults: defaults)
        XCTAssertEqual(latest?.recapId, 5)
        XCTAssertNil(latest?.imageFile)
    }
}
