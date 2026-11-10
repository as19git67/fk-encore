import XCTest
@testable import FKPhotosLib

/// The evening light of a spot in its details (reise-planen-und-unterwegs.md, stage 7, step 2).
final class TripStaySpotLightTests: XCTestCase {
    private func day(_ index: Int, _ from: Int, _ to: Int, cloudy: Bool = false, past: Bool = false) -> TripStaySpotLightDay {
        TripStaySpotLightDay(dayIndex: index, date: "2026-11-25", fromMinutes: from, toMinutes: to,
                             facade: nil, cloudCover: cloudy ? 90 : 10, cloudy: cloudy, past: past)
    }

    func testTheRangeSpansTheComingDaysInFiveMinutes() {
        let days = [day(0, 900, 930, past: true), day(1, 963, 998), day(2, 961, 1001)]
        XCTAssertEqual(TripStaySpotLightText.range(days), "ca. 16:00 bis 16:40")
        XCTAssertNil(TripStaySpotLightText.range([day(0, 900, 930, past: true)]))
    }

    func testACloudyDayNamesTheBetterOne() {
        let response = TripStaySpotLightResponse(applies: true, days: [day(1, 960, 1000), day(3, 960, 1000, cloudy: true)],
                                                 suggestedDayIndex: 1, onDayIndex: nil, fixedDayIndex: nil)
        let note = TripStaySpotLightText.cloudNote(response, weekday: { "W\($0)" }, day: { "D\($0)" })
        XCTAssertEqual(note, "D3: Wolken erwartet, W1 lohnt eher")
    }
}
