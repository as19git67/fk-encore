import XCTest
@testable import FKPhotosLib

/// The quality breakdown shown beside two photos being compared: which rows
/// exist, in what order, and what a missing reading means.
final class PhotoQualityDetailsTests: XCTestCase {

    // MARK: - Rows

    func testEveryCriterionEitherPhotoHasGetsARow() {
        // A criterion measured on only one photo still matters — it is the
        // one thing the other could not be scored on.
        let rows = PhotoQualityDetails.rows(
            first: ["sharpness": 0.8, "exposure": 0.5],
            second: ["sharpness": 0.6, "eyes_open": 0.9]
        )
        XCTAssertEqual(rows.map(\.key), ["exposure", "eyes_open", "sharpness"])
    }

    func testRowsAreSortedByTheRawKey() {
        // Not by the German label: sorting by the key keeps the row order the
        // same as the web's, and stops a reworded label reshuffling the table.
        let rows = PhotoQualityDetails.rows(
            first: ["sharpness": 0.5, "contrast": 0.5, "clip_aesthetics": 0.5],
            second: nil
        )
        XCTAssertEqual(rows.map(\.key), ["clip_aesthetics", "contrast", "sharpness"])
    }

    func testAPhotoWithoutAReadingShowsNothingRatherThanZero() {
        let rows = PhotoQualityDetails.rows(first: ["sharpness": 0.8], second: [:])
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].first ?? -1, 0.8, accuracy: 0.0001)
        XCTAssertNil(rows[0].second)
        XCTAssertEqual(PhotoQualityDetails.percent(rows[0].second), "–")
    }

    func testNoDetailsAtAllMeansNoTable() {
        XCTAssertTrue(PhotoQualityDetails.rows(first: nil, second: nil).isEmpty)
    }

    func testScoresAreHeldInsideTheirTrack() {
        // A value past 1 would draw a bar past the end of its rail.
        let rows = PhotoQualityDetails.rows(
            first: ["sharpness": 1.4], second: ["sharpness": -0.2]
        )
        XCTAssertEqual(rows[0].first ?? -1, 1, accuracy: 0.0001)
        XCTAssertEqual(rows[0].second ?? -1, 0, accuracy: 0.0001)
    }

    func testAValueThatIsNotANumberIsNoReading() {
        let rows = PhotoQualityDetails.rows(first: ["sharpness": Double.nan], second: nil)
        XCTAssertNil(rows[0].first)
    }

    // MARK: - Who is ahead

    func testTheHigherScoreLeadsItsRow() {
        let rows = PhotoQualityDetails.rows(
            first: ["sharpness": 0.9], second: ["sharpness": 0.4]
        )
        XCTAssertEqual(rows[0].leader, .first)

        let other = PhotoQualityDetails.rows(
            first: ["sharpness": 0.4], second: ["sharpness": 0.9]
        )
        XCTAssertEqual(other[0].leader, .second)
    }

    func testATieHasNoLeader() {
        let rows = PhotoQualityDetails.rows(
            first: ["sharpness": 0.5], second: ["sharpness": 0.5]
        )
        XCTAssertNil(rows[0].leader)
    }

    func testAnUnmeasuredCriterionDoesNotWinByDefault() {
        // "Measured 0.4" beating "not measured" would be a claim the data
        // does not support.
        let rows = PhotoQualityDetails.rows(first: ["sharpness": 0.4], second: nil)
        XCTAssertNil(rows[0].leader)
    }

    // MARK: - Percentages

    func testAScoreReadsAsAPercentage() {
        XCTAssertEqual(PhotoQualityDetails.percent(0.715), "72 %")
        XCTAssertEqual(PhotoQualityDetails.percent(0), "0 %")
        XCTAssertEqual(PhotoQualityDetails.percent(1), "100 %")
    }

    func testNoReadingReadsAsADash() {
        XCTAssertEqual(PhotoQualityDetails.percent(nil), "–")
    }

    // MARK: - Labels

    func testTheKnownCriteriaHaveGermanNames() {
        XCTAssertEqual(PhotoQualityDetails.label(for: "sharpness"), "Schärfe")
        XCTAssertEqual(PhotoQualityDetails.label(for: "face_sharpness"), "Gesichtsschärfe")
        XCTAssertEqual(PhotoQualityDetails.label(for: "clip_aesthetics"), "Ästhetik")
    }

    func testAnUnknownCriterionKeepsItsRawName() {
        // The scoring service can add one before either client knows it;
        // „bokeh 82 %" is more use than a row that quietly disappeared.
        XCTAssertEqual(PhotoQualityDetails.label(for: "bokeh"), "bokeh")
        let rows = PhotoQualityDetails.rows(first: ["bokeh": 0.82], second: nil)
        XCTAssertEqual(rows[0].label, "bokeh")
    }

    // MARK: - Freshening

    func testAFreshReadWins() {
        let merged = PhotoQualityDetails.merged(
            score: 0.4,
            details: nil,
            fresh: PhotoQualityDetails.Fresh(score: 0.82, details: ["sharpness": 0.9])
        )
        XCTAssertEqual(merged.score ?? -1, 0.82, accuracy: 0.0001)
        XCTAssertEqual(merged.details?["sharpness"] ?? -1, 0.9, accuracy: 0.0001)
    }

    func testAPhotoScannedAfterTheQueueLoadedStopsShowingAQuestionMark() {
        // The queue's copy can predate the quality scan, which is the whole
        // reason for re-fetching here.
        let merged = PhotoQualityDetails.merged(
            score: nil,
            details: nil,
            fresh: PhotoQualityDetails.Fresh(score: 0.66, details: ["exposure": 0.7])
        )
        XCTAssertEqual(merged.score ?? -1, 0.66, accuracy: 0.0001)
    }

    func testANotYetScoredFreshReadDoesNotWipeWhatWasKnown() {
        let merged = PhotoQualityDetails.merged(
            score: 0.4,
            details: ["sharpness": 0.5],
            fresh: PhotoQualityDetails.Fresh(score: nil, details: nil)
        )
        XCTAssertEqual(merged.score ?? -1, 0.4, accuracy: 0.0001)
        XCTAssertEqual(merged.details?["sharpness"] ?? -1, 0.5, accuracy: 0.0001)
    }

    func testNoFreshReadChangesNothing() {
        let merged = PhotoQualityDetails.merged(
            score: 0.4, details: ["sharpness": 0.5], fresh: nil
        )
        XCTAssertEqual(merged.score ?? -1, 0.4, accuracy: 0.0001)
        XCTAssertEqual(merged.details?["sharpness"] ?? -1, 0.5, accuracy: 0.0001)
    }

    // MARK: - Reading a photo

    func testAFetchedPhotoCarriesItsBreakdown() throws {
        // `/photos/details` has always sent `ai_quality_details`; until now
        // the client threw it away at the decoder.
        let json = """
        {
          "photos": [{
            "id": 1, "user_id": 1, "filename": "a.jpg", "original_name": "a.jpg",
            "mime_type": "image/jpeg", "size": 100, "hash": null,
            "taken_at": null, "created_at": "2024-06-01T12:00:00.000Z",
            "latitude": null, "longitude": null, "location_name": null,
            "location_city": null, "location_country": null,
            "ai_quality_score": 0.71,
            "ai_quality_details": {"sharpness": 0.9, "exposure": 0.55},
            "auto_crop": null, "curation_status": "visible",
            "description": null, "keywords": null
          }]
        }
        """
        let response = try JSONDecoder().decode(
            PhotoDetailsBatchResponse.self, from: Data(json.utf8)
        )
        let photo = try XCTUnwrap(response.photos.first)
        XCTAssertEqual(photo.ai_quality_details?["sharpness"] ?? -1, 0.9, accuracy: 0.0001)
        XCTAssertEqual(PhotoQualityDetails.Fresh(photo).score ?? -1, 0.71, accuracy: 0.0001)
    }

    func testAPhotoWithoutABreakdownStillDecodes() throws {
        let json = """
        {
          "photos": [{
            "id": 1, "user_id": 1, "filename": "a.jpg", "original_name": "a.jpg",
            "mime_type": "image/jpeg", "size": 100, "hash": null,
            "taken_at": null, "created_at": "2024-06-01T12:00:00.000Z",
            "latitude": null, "longitude": null, "location_name": null,
            "location_city": null, "location_country": null,
            "ai_quality_score": null, "auto_crop": null,
            "curation_status": "visible", "description": null, "keywords": null
          }]
        }
        """
        let response = try JSONDecoder().decode(
            PhotoDetailsBatchResponse.self, from: Data(json.utf8)
        )
        XCTAssertNil(response.photos.first?.ai_quality_details)
    }
}
