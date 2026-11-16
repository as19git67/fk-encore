import XCTest
@testable import FKPhotosLib

/// Stays as the frame of the trip (review of the trip planner sheets,
/// section A): a pinned stay keeps its first day, the first stay's
/// "Von" is the trip's date even with home, and "Bis" sets the length.
final class TripItineraryPinTests: XCTestCase {

    private let berlin = TimeZone(identifier: "Europe/Berlin")!

    private func stay(_ title: String, days: Int) -> TripItineraryItem {
        var item = TripItineraryItem(kind: .stay)
        item.title = title
        item.days = days
        item.mode = TripTransportMode.foot.rawValue
        item.anchor = TripCoordinate(lat: 48.1, lon: 11.5)
        return item
    }

    /// A for two days, a journey, a port for one day, a journey, C for two.
    private var chain: TripItineraryDraft {
        TripItineraryDraft(startDate: "2027-06-03", hasHome: false, items: [
            stay("Ort A", days: 2), stay("Hafen", days: 1), stay("Ort C", days: 2),
        ])
    }

    func testAPinnedStayKeepsItsDayAndTheJourneyBeforeTakesUpTheGap() {
        var draft = chain
        let port = draft.items[2].id
        XCTAssertTrue(draft.canPin(port))
        XCTAssertFalse(draft.canPin(draft.items[0].id))
        draft.setStart(of: port, to: "2027-06-07", timeZone: berlin)

        var dated = draft.dated(timeZone: berlin)
        XCTAssertEqual(dated[2].startDate, "2027-06-07")
        XCTAssertEqual(dated[1].item.nights, 3)
        XCTAssertEqual(dated[4].startDate, "2027-06-07")
        XCTAssertTrue(draft.isPinned(port))

        // A longer first stay does not move the port; the gap shrinks.
        var first = draft.items[0]
        first.days = 4
        draft[first.id] = first
        dated = draft.dated(timeZone: berlin)
        XCTAssertEqual(dated[2].startDate, "2027-06-07")
        XCTAssertEqual(dated[1].item.nights, 1)
        XCTAssertTrue(draft.problems().isEmpty)
    }

    func testAStayThatRunsIntoThePinIsNamedAndNotSaved() {
        var draft = chain
        let port = draft.items[2].id
        draft.setStart(of: port, to: "2027-06-05", timeZone: berlin)
        var first = draft.items[0]
        first.days = 5
        draft[first.id] = first
        XCTAssertTrue(draft.problems().contains { $0.contains("2 Tage zu viel") })

        first.days = 2
        draft[first.id] = first
        draft.setStart(of: port, to: "2027-06-30", timeZone: berlin)
        XCTAssertTrue(draft.problems().contains { $0.contains("höchstens 6") })
    }

    func testLooseningAPinKeepsTheGapItHad() {
        var draft = chain
        let port = draft.items[2].id
        draft.setStart(of: port, to: "2027-06-07", timeZone: berlin)
        draft.setPinned(port, false, timeZone: berlin)
        XCTAssertNil(draft[port]?.pinnedStart)
        XCTAssertEqual(draft.dated(timeZone: berlin)[2].startDate, "2027-06-07")
        // Pinned again on the day it falls on now.
        draft.setPinned(port, true, timeZone: berlin)
        XCTAssertEqual(draft[port]?.pinnedStart, "2027-06-07")
    }

    func testWithoutADateNothingIsPinned() {
        var draft = chain
        draft.setStart(of: draft.items[2].id, to: "2027-06-07", timeZone: berlin)
        draft.startDate = nil
        XCTAssertFalse(draft.canPin(draft.items[2].id))
        XCTAssertFalse(draft.isPinned(draft.items[2].id))
        XCTAssertTrue(draft.problems().isEmpty)
    }

    func testTheFirstStaysVonIsTheTripsDateCountedBackOverTheWayThere() {
        var draft = chain
        draft.setHome("Daheim")
        var outbound = draft.items[0]
        outbound.nights = 1
        draft[outbound.id] = outbound
        let first = draft.items[1].id
        XCTAssertTrue(draft.isFirstStay(first))
        draft.setStart(of: first, to: "2027-06-10", timeZone: berlin)
        XCTAssertEqual(draft.startDate, "2027-06-09")
        XCTAssertEqual(draft.dated(timeZone: berlin)[1].startDate, "2027-06-10")
    }

    func testBisSetsTheLength() {
        var draft = chain
        let first = draft.items[0].id
        draft.setEnd(of: first, to: "2027-06-06", timeZone: berlin)
        XCTAssertEqual(draft[first]?.days, 4)
        draft.setEnd(of: first, to: "2027-05-01", timeZone: berlin)
        XCTAssertEqual(draft[first]?.days, 1)
    }

    func testThePinAndTheLastStaysDepartureGoOverTheWire() throws {
        var draft = chain
        draft.setStart(of: draft.items[2].id, to: "2027-06-07", timeZone: berlin)
        var last = draft.items[4]
        last.departAt = "11:30"
        draft[last.id] = last
        let encoded = try JSONEncoder().encode(draft.request)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let items = try XCTUnwrap(object["items"] as? [[String: Any]])
        XCTAssertEqual(items[2]["pinnedStart"] as? String, "2027-06-07")
        XCTAssertTrue(items[0]["pinnedStart"] is NSNull)
        XCTAssertEqual(items[4]["departAt"] as? String, "11:30")
    }
}
