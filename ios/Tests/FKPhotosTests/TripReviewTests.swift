import XCTest
@testable import FKPhotosLib

/// Afterwards, as the screen reads it (§8.7).
///
/// The two things worth pinning down: a stop somebody stood at without
/// ticking off says both facts rather than picking one, and a skipped
/// stop is never dressed as a failure.
final class TripReviewTests: XCTestCase {

    private let json = """
    {
      "startsOn": "2026-06-18",
      "endsOn": "2026-06-20",
      "recap": { "id": 12, "title": "Zwei Tage Weststadt",
                 "subtitle": "18.–19. Juni", "photos": 14 },
      "totals": { "planned": 6, "done": 3, "skipped": 1, "untouched": 2,
                  "unplanned": 1, "photos": 14 },
      "stops": [
        { "legIndex": 0, "dayIndex": 0, "date": "2026-06-18", "osmRef": "node:1",
          "name": "Stadtmuseum", "status": "done", "visited": true, "photos": 9 },
        { "legIndex": 0, "dayIndex": 0, "date": "2026-06-18", "osmRef": "node:2",
          "name": "Aussichtsturm", "status": "planned", "visited": true, "photos": 5 },
        { "legIndex": 0, "dayIndex": 1, "date": "2026-06-19", "osmRef": "node:3",
          "name": null, "status": "skipped", "visited": false, "photos": 0 }
      ],
      "unplanned": [
        { "name": "Buchladen um die Ecke", "osmRef": "node:99",
          "lat": 48.37, "lon": 10.9, "arrivedAt": "2026-06-19T15:04:00.000Z",
          "photos": 2 }
      ]
    }
    """

    private func review() throws -> TripReview {
        try JSONDecoder().decode(TripReview.self, from: Data(json.utf8))
    }

    func testTheAnswerDecodes() throws {
        let review = try review()

        XCTAssertEqual(review.recap?.title, "Zwei Tage Weststadt")

        XCTAssertEqual(review.stops.count, 3)
        XCTAssertEqual(review.unplanned.first?.displayName, "Buchladen um die Ecke")
        XCTAssertEqual(review.totals.photos, 14)
        XCTAssertEqual(review.period, "2026-06-18 – 2026-06-20")
    }

    func testAOneDayTripDoesNotShowARange() throws {
        let review = TripReview(startsOn: "2026-06-18", endsOn: "2026-06-18",
                                stops: [], unplanned: [],
                                totals: TripReviewTotals(planned: 0, done: 0, skipped: 0,
                                                         untouched: 0, unplanned: 0, photos: 0),
                                recap: nil)
        XCTAssertEqual(review.period, "2026-06-18")
    }

    func testBeingThereAndTickingItOffAreTwoDifferentRecords() throws {
        let visitedButOpen = try review().stops[1]

        XCTAssertTrue(visitedButOpen.subtitle.contains("abgehakt ist es nicht"))
        XCTAssertEqual(visitedButOpen.symbolName, "mappin.circle.fill")
    }

    func testASkippedStopIsNotDressedAsAFailure() throws {
        let skipped = try review().stops[2]

        // Grey and a minus, not red and a cross: a day that went
        // differently is the ordinary case (§5).
        XCTAssertEqual(skipped.symbolName, "minus.circle")
        XCTAssertEqual(skipped.tint, .secondary)
        XCTAssertEqual(skipped.displayName, "Unbenannter Ort")
    }

    func testAFinishedStopReadsAsFinished() throws {
        let done = try review().stops[0]

        XCTAssertEqual(done.symbolName, "checkmark.circle.fill")
        XCTAssertEqual(done.tint, .green)
        XCTAssertEqual(done.subtitle, "2026-06-18")
    }

    func testAnUnplannedStayCarriesItsDayAndItsPhotos() throws {
        let stay = try review().unplanned[0]

        XCTAssertEqual(stay.subtitle, "2026-06-19 · 2 Fotos")
    }
}
