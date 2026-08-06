import XCTest
@testable import FKPhotosLib

/// Locks the semantics of the album views (issue #760) against the backend
/// presets in `photo/photo.service.ts` (`VIEW_PRESETS`) and the feature spec in
/// `docs/album-photo-views.md`. The SwiftUI grid is verified on-device; these
/// pin the filter decisions, which is where a regression would silently show
/// the wrong photos to a whole group.
final class AlbumViewModeTests: XCTestCase {

    private func stats(fav: Int, hide: Int = 0, members: Int = 5) -> PhotoCurationStats {
        PhotoCurationStats(fav_count: fav, hide_count: hide, member_count: members)
    }

    // MARK: - Mode availability

    func testConsensusModesAreHiddenOnUnsharedAlbums() {
        let solo = AlbumViewMode.available(isShared: false)
        XCTAssertEqual(solo, [.all, .favorites])

        let shared = AlbumViewMode.available(isShared: true)
        XCTAssertEqual(shared, [.all, .favorites, .consensus, .othersFavorites, .custom])
    }

    // MARK: - "Alle Fotos"

    func testAllModeKeepsEverything() {
        let filter = AlbumViewFilter(mode: .all)
        XCTAssertTrue(filter.matches(curation: .visible, stats: stats(fav: 0, hide: 4)))
        XCTAssertTrue(filter.matches(curation: .favorite, stats: nil))
    }

    // MARK: - "Meine Favoriten"

    func testFavoritesModeOnlyKeepsMyOwnFavorites() {
        let filter = AlbumViewFilter(mode: .favorites)
        XCTAssertTrue(filter.matches(curation: .favorite, stats: stats(fav: 1)))
        XCTAssertFalse(filter.matches(curation: .visible, stats: stats(fav: 4)))
    }

    // MARK: - "Gruppen-Highlights" (backend preset: favMin 2, hideMin 1)

    func testConsensusNeedsTwoFavoritesAndNoHides() {
        let filter = AlbumViewFilter(mode: .consensus)
        XCTAssertTrue(filter.matches(curation: .visible, stats: stats(fav: 2, hide: 0)))
        XCTAssertTrue(filter.matches(curation: .visible, stats: stats(fav: 5, hide: 0)))
        // One single favorite is not a consensus.
        XCTAssertFalse(filter.matches(curation: .favorite, stats: stats(fav: 1, hide: 0)))
        // A single hide vetoes the photo, however many favorites it has.
        XCTAssertFalse(filter.matches(curation: .visible, stats: stats(fav: 4, hide: 1)))
    }

    // MARK: - "Von anderen favorisiert" (backend preset: others-not-mine)

    func testOthersFavoritesExcludesMyOwnFavorites() {
        let filter = AlbumViewFilter(mode: .othersFavorites)
        // Somebody likes it, I have not voted → this is the "what did I miss" case.
        XCTAssertTrue(filter.matches(curation: .visible, stats: stats(fav: 1)))
        // I already favorited it, so it is not news to me.
        XCTAssertFalse(filter.matches(curation: .favorite, stats: stats(fav: 3)))
        // Nobody voted at all.
        XCTAssertFalse(filter.matches(curation: .visible, stats: stats(fav: 0)))
    }

    // MARK: - Custom thresholds

    func testCustomModeUsesConfiguredThresholds() {
        let filter = AlbumViewFilter(mode: .custom, config: AlbumViewConfig(favMin: 3, hideMax: 1))
        XCTAssertTrue(filter.matches(curation: .visible, stats: stats(fav: 3, hide: 1)))
        XCTAssertFalse(filter.matches(curation: .visible, stats: stats(fav: 2, hide: 0)))
        XCTAssertFalse(filter.matches(curation: .visible, stats: stats(fav: 4, hide: 2)))
    }

    func testCustomDefaultsReproduceTheConsensusPreset() {
        let custom = AlbumViewFilter(mode: .custom, config: .default)
        let consensus = AlbumViewFilter(mode: .consensus)
        for fav in 0...4 {
            for hide in 0...2 {
                let s = stats(fav: fav, hide: hide)
                XCTAssertEqual(
                    custom.matches(curation: .visible, stats: s),
                    consensus.matches(curation: .visible, stats: s),
                    "fav=\(fav) hide=\(hide) must agree with the consensus preset"
                )
            }
        }
    }

    func testConfigIsClampedToParticipantCount() {
        let clamped = AlbumViewConfig(favMin: 99, hideMax: -3).clamped(memberCount: 4)
        XCTAssertEqual(clamped.favMin, 4)
        XCTAssertEqual(clamped.hideMax, 0)
    }

    func testClampingNeverCollapsesToZeroUpperBound() {
        // An album whose member count is unknown (0) must still allow a
        // threshold of 1, otherwise the stepper would be stuck at 0.
        let clamped = AlbumViewConfig(favMin: 2, hideMax: 0).clamped(memberCount: 0)
        XCTAssertEqual(clamped.favMin, 1)
    }

    // MARK: - Threshold summary shown in the toolbar menu

    func testOnlyTheCustomModeSummarisesItsThresholds() {
        for mode in [AlbumViewMode.all, .favorites, .consensus, .othersFavorites] {
            XCTAssertNil(AlbumViewFilter(mode: mode).summary)
        }
        XCTAssertEqual(
            AlbumViewFilter(mode: .custom, config: AlbumViewConfig(favMin: 2, hideMax: 0)).summary,
            "ab 2 Favoriten, keine Ausblendung"
        )
        XCTAssertEqual(
            AlbumViewFilter(mode: .custom, config: AlbumViewConfig(favMin: 1, hideMax: 2)).summary,
            "ab 1 Favorit, max. 2 Ausblendungen"
        )
    }

    // MARK: - Missing stats

    func testCounterModesPassEverythingWithoutStats() {
        // Unshared albums carry no counters. Filtering them all away would show
        // an empty grid with no explanation, so the modes degrade to "all".
        for mode in [AlbumViewMode.consensus, .othersFavorites, .custom] {
            XCTAssertTrue(
                AlbumViewFilter(mode: mode).matches(curation: .visible, stats: nil),
                "\(mode) must not empty the grid when the server sent no counters"
            )
        }
    }

    // MARK: - Optimistic vote accounting

    func testCastingFavoriteRaisesTheCounter() {
        let updated = stats(fav: 2, hide: 1).applying(vote: .visible, to: .favorite)
        XCTAssertEqual(updated.favCount, 3)
        XCTAssertEqual(updated.hideCount, 1)
        XCTAssertEqual(updated.memberCount, 5)
    }

    func testWithdrawingFavoriteLowersTheCounter() {
        let updated = stats(fav: 3).applying(vote: .favorite, to: .visible)
        XCTAssertEqual(updated.favCount, 2)
    }

    func testSwitchingFromHiddenToFavoriteMovesOneVote() {
        let updated = stats(fav: 1, hide: 2).applying(vote: .hidden, to: .favorite)
        XCTAssertEqual(updated.favCount, 2)
        XCTAssertEqual(updated.hideCount, 1)
    }

    func testUnchangedVoteIsANoOp() {
        let original = stats(fav: 2, hide: 1)
        XCTAssertEqual(original.applying(vote: .favorite, to: .favorite), original)
    }

    func testCountersNeverGoNegative() {
        // Defensive: a stale counter must not produce "-1 von 5".
        let updated = PhotoCurationStats(fav_count: 0, hide_count: 0, member_count: 3)
            .applying(vote: .favorite, to: .visible)
        XCTAssertEqual(updated.favCount, 0)
    }

    func testLegacyStatsWithoutHideCountReadAsZero() {
        let legacy = PhotoCurationStats(fav_count: 2)
        XCTAssertEqual(legacy.hideCount, 0)
        XCTAssertEqual(legacy.memberCount, 0)
        XCTAssertTrue(legacy.hasSignal)
    }

    // MARK: - Persistence

    func testViewModeRoundTripsThroughTheStore() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "AlbumViewModeTests.roundTrip"))
        defaults.removePersistentDomain(forName: "AlbumViewModeTests.roundTrip")

        let filter = AlbumViewFilter(mode: .custom, config: AlbumViewConfig(favMin: 3, hideMax: 2))
        AlbumViewModeStore.save(filter, albumId: 7, defaults: defaults)

        XCTAssertEqual(AlbumViewModeStore.load(albumId: 7, defaults: defaults), filter)
        // Different album, untouched default.
        XCTAssertEqual(AlbumViewModeStore.load(albumId: 8, defaults: defaults).mode, .all)
    }

    func testSavingTheDefaultModeClearsTheStoredEntry() throws {
        let suite = "AlbumViewModeTests.clear"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)

        AlbumViewModeStore.save(AlbumViewFilter(mode: .consensus), albumId: 1, defaults: defaults)
        XCTAssertNotNil(defaults.data(forKey: AlbumViewModeStore.key(albumId: 1)))

        AlbumViewModeStore.save(AlbumViewFilter(mode: .all), albumId: 1, defaults: defaults)
        XCTAssertNil(defaults.data(forKey: AlbumViewModeStore.key(albumId: 1)))
    }

    // MARK: - Wire format

    func testAlbumPhotoRowDecodesPhotoAndStatsFromOneFlatObject() throws {
        let json = """
        {
          "id": 42,
          "user_id": 1,
          "filename": "a.jpg",
          "original_name": "a.jpg",
          "mime_type": "image/jpeg",
          "size": 1024,
          "created_at": "2026-01-01T00:00:00Z",
          "curation_status": "favorite",
          "curation_stats": { "fav_count": 3, "hide_count": 1, "member_count": 5 }
        }
        """.data(using: .utf8)!

        let row = try JSONDecoder().decode(AlbumPhotoRow.self, from: json)
        XCTAssertEqual(row.id, 42)
        XCTAssertEqual(row.photo.filename, "a.jpg")
        XCTAssertEqual(row.photo.curation_status, .favorite)
        XCTAssertEqual(row.curation_stats?.favCount, 3)
        XCTAssertEqual(row.curation_stats?.hideCount, 1)
        XCTAssertEqual(row.curation_stats?.memberCount, 5)
    }

    func testAlbumPhotoRowDecodesWithoutStats() throws {
        let json = """
        {
          "id": 7,
          "user_id": 1,
          "filename": "b.jpg",
          "original_name": "b.jpg",
          "mime_type": "image/jpeg",
          "size": 10,
          "created_at": "2026-01-01T00:00:00Z",
          "curation_status": "visible"
        }
        """.data(using: .utf8)!

        let row = try JSONDecoder().decode(AlbumPhotoRow.self, from: json)
        XCTAssertNil(row.curation_stats)
    }
}
