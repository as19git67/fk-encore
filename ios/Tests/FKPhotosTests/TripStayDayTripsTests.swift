import XCTest
@testable import FKPhotosLib

/// Day trips as a chip of the spot picker (reise-planen-und-unterwegs.md, stage 7, step 3).
final class TripStayDayTripsTests: XCTestCase {
    private func target(minutes: Int, spots: Int) -> TripDayTripTarget {
        TripDayTripTarget(name: "Beispielstadt", source: "admin", key: "area:900", osmRef: "area:900",
                          lat: 44.0, lon: 11.0, distanceM: 60_000, travelMinutes: minutes,
                          dayAtTargetMinutes: 600 - 2 * minutes, spotCount: spots, examples: [])
    }

    func testTheLineRoundsTheDriveAndCountsThePlaces() {
        XCTAssertEqual(TripStayDayTripText.line(target(minutes: 63, spots: 40)), "ca. 1 h 5 Fahrt · 40 Orte")
        XCTAssertEqual(TripStayDayTripText.line(target(minutes: 31, spots: 1)), "ca. 30 min Fahrt · 1 Ort")
    }

    func testTheChipSitsBetweenHighlightsAndFood() {
        XCTAssertEqual(TripPickerChip.allCases.map(\.label),
                       ["Alles", "Ideen", "Highlights", "Ausflüge", "Essen", "Mehr"])
        XCTAssertTrue(TripSpotPicker.items(chip: .trips, query: "", ideas: [], highlights: [], results: []).isEmpty)
    }
}
