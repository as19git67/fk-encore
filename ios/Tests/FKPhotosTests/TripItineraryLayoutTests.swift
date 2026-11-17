import XCTest
@testable import FKPhotosLib

/// The itinerary reckons its dates, subtitles, day rows and problems once
/// per change (`TripItineraryLayout`), and the date helpers share their
/// formatters (`TripFormatterCache`). Both only make the list cheaper to
/// scroll; what it shows must stay what it was.
final class TripItineraryLayoutTests: XCTestCase {

    private func stay(_ title: String, days: Int) -> TripItineraryItem {
        var item = TripItineraryItem(kind: .stay)
        item.title = title
        item.days = days
        item.mode = TripTransportMode.foot.rawValue
        item.anchor = TripCoordinate(lat: 48.1, lon: 11.5)
        return item
    }

    private func journey(arriveAt: String? = nil) -> TripItineraryItem {
        var item = TripItineraryItem(kind: .journey)
        item.mode = TripTransportMode.car.rawValue
        item.arriveAt = arriveAt
        item.nights = 0
        return item
    }

    private var draft: TripItineraryDraft {
        TripItineraryDraft(startDate: "2026-11-26", hasHome: false, items: [
            stay("Ort A", days: 3),
            journey(arriveAt: "12:30"),
            stay("Ort B", days: 2),
        ])
    }

    func testTheLayoutSaysWhatTheRowsSaidOnTheirOwn() {
        let draft = draft
        let layout = TripItineraryLayout(draft: draft, legDays: [:])
        let dated = draft.dated()
        XCTAssertEqual(layout.dated, dated)
        XCTAssertEqual(layout.span, TripItineraryText.tripSpan(draft))
        XCTAssertEqual(layout.problems, draft.problems())

        let second = draft.items[2]
        XCTAssertEqual(layout.dayRows[second.id], TripItineraryDays.rows(
            stay: second, dated: dated[2], days: [], arrival: "12:30", departure: nil))
        XCTAssertEqual(layout.dayRows[second.id]?.first?.label.hasSuffix("an 12:30"), true)
        XCTAssertEqual(layout.dayRows[draft.items[0].id]?.count, 3)
        XCTAssertEqual(layout.subtitles[second.id], TripItineraryLayout.subtitle(
            second, dated: dated[2], dayOffsets: TripItineraryText.dayOffsets(of: draft)[2], in: draft))
        XCTAssertNil(layout.subtitles[draft.items[1].id], "a journey has no subtitle")
    }

    func testTheMemoBuildsAgainWhenTheChainChanges() {
        let memo = TripItineraryLayoutMemo()
        var draft = draft
        XCTAssertEqual(memo.layout(of: draft, legs: []).dayRows[draft.items[0].id]?.count, 3)
        var first = draft.items[0]
        first.days = 4
        draft[first.id] = first
        XCTAssertEqual(memo.layout(of: draft, legs: []).dayRows[draft.items[0].id]?.count, 4)
    }

    func testSharedFormattersWriteTheSameDays() {
        let zone = TimeZone(identifier: "Europe/Berlin")!
        XCTAssertEqual(TripCalendar.day("2026-11-26", plus: 5, timeZone: zone), "2026-12-01")
        XCTAssertEqual(TripCalendar.day("2026-11-26", plus: 5, timeZone: zone), "2026-12-01")
        XCTAssertEqual(TripCalendar.days(from: "2026-11-26", to: "2026-12-01", timeZone: zone), 5)
        let tokyo = TimeZone(identifier: "Asia/Tokyo")!
        XCTAssertEqual(TripCalendar.day("2026-12-31", plus: 1, timeZone: tokyo), "2027-01-01")
        XCTAssertEqual(TripItineraryText.shortDate("2026-11-26", timeZone: zone),
                       TripItineraryText.shortDate("2026-11-26", timeZone: zone))
    }
}
