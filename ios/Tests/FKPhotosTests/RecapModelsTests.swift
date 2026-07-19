import XCTest
@testable import FKPhotosLib

/// Decode guards for the recap JSON contract (#759). Locks field mapping and the
/// lenient kind handling the list relies on.
final class RecapModelsTests: XCTestCase {

    func testDecodeListResponseAndKindMapping() throws {
        let json = """
        { "recaps": [
            { "id": 1, "kind": "on_this_day", "title": "Vor 3 Jahren", "subtitle": "15. Juni",
              "cover_photo_id": 42, "period_start": null, "period_end": null,
              "photo_count": 7, "created_at": "2026-06-15T00:00:00Z",
              "dismissed_at": null, "seen_at": null },
            { "id": 2, "kind": "trip", "title": "Wochenende in Rom", "subtitle": null,
              "cover_photo_id": null, "period_start": null, "period_end": null,
              "photo_count": 23, "created_at": "2026-06-10T00:00:00Z",
              "dismissed_at": null, "seen_at": "2026-06-16T00:00:00Z" }
        ] }
        """.data(using: .utf8)!

        let response = try JSONDecoder().decode(ListRecapsResponse.self, from: json)
        XCTAssertEqual(response.recaps.count, 2)
        XCTAssertEqual(response.recaps[0].recapKind, .onThisDay)
        XCTAssertEqual(response.recaps[0].cover_photo_id, 42)
        XCTAssertNil(response.recaps[0].seen_at)
        XCTAssertEqual(response.recaps[1].recapKind, .trip)
        XCTAssertNil(response.recaps[1].subtitle)
    }

    func testUnknownKindFallsBackToOther() {
        XCTAssertEqual(RecapKind(raw: "brand_new_kind"), .other)
        XCTAssertEqual(RecapKind(raw: "person"), .person)
    }

    func testDecodeRecapDetailsPreservesPhotoOrder() throws {
        let json = """
        { "recap": { "id": 9, "kind": "person", "title": "Mit Anna", "subtitle": "Zuletzt",
          "cover_photo_id": 5, "period_start": null, "period_end": null,
          "photo_count": 3, "created_at": "2026-06-01T00:00:00Z",
          "dismissed_at": null, "seen_at": null, "photo_ids": [5, 9, 2] } }
        """.data(using: .utf8)!

        let response = try JSONDecoder().decode(GetRecapResponse.self, from: json)
        XCTAssertEqual(response.recap.photo_ids, [5, 9, 2])
        XCTAssertEqual(response.recap.recapKind, .person)
        XCTAssertNil(response.music)
    }

    func testDecodeRecapDetailsWithMusicTrack() throws {
        let json = """
        { "recap": { "id": 9, "kind": "trip", "title": "Rom", "subtitle": null,
          "cover_photo_id": null, "period_start": null, "period_end": null,
          "photo_count": 1, "created_at": "2026-06-01T00:00:00Z",
          "dismissed_at": null, "seen_at": null, "photo_ids": [5],
          "seed": { "location_city": "Rom", "centroid_lat": 41.9, "centroid_lon": 12.5,
            "home_lat": 48.25, "home_lon": 10.98, "duration_days": 4, "llm_title": true } },
          "music": { "id": "upbeat/01_sunny-road.mp3", "mood": "upbeat",
            "title": "Sunny Road", "url": "/recaps-music/file/upbeat/01_sunny-road.mp3" } }
        """.data(using: .utf8)!

        let response = try JSONDecoder().decode(GetRecapResponse.self, from: json)
        XCTAssertEqual(response.music?.id, "upbeat/01_sunny-road.mp3")
        XCTAssertEqual(response.music?.mood, "upbeat")
        XCTAssertEqual(response.recap.seed?.centroid_lat, 41.9)
        XCTAssertEqual(response.recap.seed?.home_lon, 10.98)
        XCTAssertEqual(response.recap.seed?.location_city, "Rom")
    }

    func testOrderedMusicCycleStartsAtSuggestedAndWraps() {
        let tracks = ["a", "b", "c", "d"].map {
            RecapMusicTrack(id: $0, mood: "calm", title: $0, url: "/recaps-music/file/\($0)")
        }
        let cycle = RecapPlayerView.orderedMusicCycle(tracks, suggestedId: "c")
        XCTAssertEqual(cycle.map(\.id), ["c", "d", "a", "b"])

        // Unknown id falls back to the head; empty stays empty.
        XCTAssertEqual(
            RecapPlayerView.orderedMusicCycle(tracks, suggestedId: "zzz").map(\.id),
            ["a", "b", "c", "d"]
        )
        XCTAssertTrue(RecapPlayerView.orderedMusicCycle([], suggestedId: "a").isEmpty)
    }
}
