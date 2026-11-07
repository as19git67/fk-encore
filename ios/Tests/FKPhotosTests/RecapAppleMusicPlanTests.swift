import XCTest
@testable import FKPhotosLib

/// Rules of the Apple Music pick for recaps (`RecapAppleMusicPlan`).
final class RecapAppleMusicPlanTests: XCTestCase {

    private func date(_ iso: String) -> Date {
        RecapAppleMusicPlan.parseDate(iso)!
    }

    func testWindowPadsTheTripPeriod() throws {
        let window = try XCTUnwrap(RecapAppleMusicPlan.libraryWindow(
            periodStart: "2023-07-10T00:00:00.000Z",
            periodEnd: "2023-07-20T00:00:00Z"
        ))
        XCTAssertEqual(window.start, date("2023-06-10T00:00:00Z"))
        XCTAssertEqual(window.end, date("2023-08-19T00:00:00Z"))
    }

    func testSingleDayRecapUsesItsDay() throws {
        let window = try XCTUnwrap(RecapAppleMusicPlan.libraryWindow(
            periodStart: "2019-11-07T00:00:00Z",
            periodEnd: nil
        ))
        XCTAssertTrue(window.contains(date("2019-11-20T00:00:00Z")))
        XCTAssertFalse(window.contains(date("2020-01-20T00:00:00Z")))
    }

    func testLongPeriodIsNoTime() {
        XCTAssertNil(RecapAppleMusicPlan.libraryWindow(
            periodStart: "2015-01-01T00:00:00Z",
            periodEnd: "2024-01-01T00:00:00Z"
        ))
        XCTAssertNil(RecapAppleMusicPlan.libraryWindow(periodStart: nil, periodEnd: nil))
    }

    func testTooFewLibrarySongsGiveNothing() throws {
        let window = try XCTUnwrap(RecapAppleMusicPlan.libraryWindow(
            periodStart: "2023-07-10T00:00:00Z",
            periodEnd: "2023-07-20T00:00:00Z"
        ))
        let inside = date("2023-07-15T00:00:00Z")
        let outside = date("2021-01-01T00:00:00Z")
        let few: [Date?] = Array(repeating: inside, count: RecapAppleMusicPlan.minimumLibrarySongs - 1)
            + [outside, nil]
        XCTAssertTrue(RecapAppleMusicPlan.librarySongs(few, addedAt: { $0 }, in: window).isEmpty)

        let enough: [Date?] = Array(repeating: inside, count: RecapAppleMusicPlan.minimumLibrarySongs)
            + [outside, nil]
        XCTAssertEqual(
            RecapAppleMusicPlan.librarySongs(enough, addedAt: { $0 }, in: window).count,
            RecapAppleMusicPlan.minimumLibrarySongs
        )
    }

    func testPeriodLabel() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        XCTAssertEqual(
            RecapAppleMusicPlan.periodLabel(
                periodStart: "2023-07-10T00:00:00Z", periodEnd: "2023-07-20T00:00:00Z", calendar: calendar
            ),
            "Juli 2023"
        )
        XCTAssertEqual(
            RecapAppleMusicPlan.periodLabel(
                periodStart: "2023-06-28T00:00:00Z", periodEnd: "2023-08-02T00:00:00Z", calendar: calendar
            ),
            "Juni – August 2023"
        )
    }

    func testMoodFromServer() {
        XCTAssertEqual(RecapMusicMood(raw: "nostalgic"), .nostalgic)
        XCTAssertNil(RecapMusicMood(raw: "unknown"))
        XCTAssertNil(RecapMusicMood(raw: nil))
        for mood in RecapMusicMood.allCases {
            XCTAssertFalse(mood.catalogSearchTerms.isEmpty)
        }
    }

    func testChosenPlaylistIsKeptPerRecap() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "RecapAppleMusicPlanTests"))
        defaults.removePersistentDomain(forName: "RecapAppleMusicPlanTests")
        XCTAssertNil(AppleMusicPreferences.playlistId(forRecap: 1, defaults: defaults))
        AppleMusicPreferences.setPlaylistId("p.abc", forRecap: 1, defaults: defaults)
        XCTAssertEqual(AppleMusicPreferences.playlistId(forRecap: 1, defaults: defaults), "p.abc")
        XCTAssertNil(AppleMusicPreferences.playlistId(forRecap: 2, defaults: defaults))
        AppleMusicPreferences.setPlaylistId(nil, forRecap: 1, defaults: defaults)
        XCTAssertNil(AppleMusicPreferences.playlistId(forRecap: 1, defaults: defaults))
    }

    func testDetailDecodesMood() throws {
        let json = """
        { "recap": { "id": 9, "kind": "trip", "title": "Rom", "subtitle": null,
          "cover_photo_id": null, "period_start": "2023-07-10T00:00:00.000Z",
          "period_end": "2023-07-20T00:00:00.000Z", "photo_count": 0,
          "created_at": "2026-06-01T00:00:00Z", "dismissed_at": null, "seen_at": null,
          "photo_ids": [], "seed": null },
          "mood": "upbeat", "counterparts": [] }
        """.data(using: .utf8)!
        let response = try JSONDecoder().decode(GetRecapResponse.self, from: json)
        XCTAssertEqual(RecapMusicMood(raw: response.mood), .upbeat)
    }
}
