import XCTest
@testable import FKPhotosLib

/// A journey with a ticket (train, flight): it keeps its day like a
/// pinned stay; the stay before it ends on the departure day, the
/// stays after follow its arrival, and what does not fit is named.
final class TripItineraryTicketTests: XCTestCase {

    private let berlin = TimeZone(identifier: "Europe/Berlin")!

    private func stay(_ title: String, days: Int) -> TripItineraryItem {
        var item = TripItineraryItem(kind: .stay)
        item.title = title
        item.days = days
        item.mode = TripTransportMode.foot.rawValue
        item.anchor = TripCoordinate(lat: 48.1, lon: 11.5)
        return item
    }

    /// Home, A for four days, a journey, B for three, home.
    private var chain: TripItineraryDraft {
        TripItineraryDraft(startDate: "2027-06-03", hasHome: true, items: [
            stay("Ort A", days: 4), stay("Ort B", days: 3),
        ])
    }

    func testATicketEndsTheStayBeforeOnItsDayAndTheRestFollows() {
        var draft = chain
        let journey = draft.items[2].id
        draft.setTicket(journey, day: "2027-06-05", timeZone: berlin)

        XCTAssertTrue(draft[journey]?.isTicketed == true)
        // A ticket needs both times; open ones get the assumed ones.
        XCTAssertEqual(draft[journey]?.departAt, "10:00")
        XCTAssertNotNil(draft[journey]?.arriveAt)
        XCTAssertEqual(draft.items[1].days, 3)
        let dated = draft.dated(timeZone: berlin)
        XCTAssertEqual(dated[1].endDate, "2027-06-05")
        XCTAssertEqual(dated[3].startDate, "2027-06-05")
        XCTAssertTrue(draft.leavesByTicket(draft.items[1].id))
        XCTAssertTrue(draft.arrivesByTicket(draft.items[3].id))

        // A night train: the arrival day sets the nights, B follows.
        draft.setTicketArrival(journey, day: "2027-06-06", timeZone: berlin)
        XCTAssertEqual(draft[journey]?.nights, 1)
        XCTAssertEqual(draft.dated(timeZone: berlin)[3].startDate, "2027-06-06")

        // A longer A does not move the ticket.
        var first = draft.items[1]
        first.days = 6
        draft[first.id] = first
        XCTAssertEqual(draft.items[1].days, 3)
        XCTAssertTrue(draft.problems().isEmpty)
    }

    func testATicketBeforeTheStayBeginsIsNamed() {
        var draft = chain
        draft.setTicket(draft.items[2].id, day: "2027-06-01", timeZone: berlin)
        XCTAssertTrue(draft.problems().contains { $0.contains("beginnt erst am") })

        draft.setTicket(draft.items[2].id, day: "2027-06-30", timeZone: berlin)
        XCTAssertTrue(draft.problems().contains { $0.contains("höchstens 14") })
    }

    func testAPinnedStayAfterATicketOnAnotherDayIsNamed() {
        var draft = TripItineraryDraft(startDate: "2027-06-03", hasHome: false, items: [
            stay("Ort A", days: 2), stay("Hafen", days: 2),
        ])
        let port = draft.items[2].id
        draft.setStart(of: port, to: "2027-06-08", timeZone: berlin)
        draft.setTicket(draft.items[1].id, day: "2027-06-04", timeZone: berlin)
        XCTAssertTrue(draft.problems().contains { $0.contains("Einen der beiden Termine lösen") })
    }

    func testAnOutboundTicketIsTheTripsDateAndATicketDatesATripWithoutOne() {
        var draft = chain
        draft.setTicket(draft.items[0].id, day: "2027-06-10", timeZone: berlin)
        XCTAssertEqual(draft.startDate, "2027-06-10")
        // The first stay's "Von" cannot move it.
        draft.setStart(of: draft.items[1].id, to: "2027-06-01", timeZone: berlin)
        XCTAssertEqual(draft.startDate, "2027-06-10")

        var undated = TripItineraryDraft(startDate: nil, hasHome: true, items: [
            stay("Ort A", days: 4), stay("Ort B", days: 3),
        ])
        undated.setTicket(undated.items[2].id, day: "2027-06-12", timeZone: berlin)
        XCTAssertEqual(undated.startDate, "2027-06-09")
        XCTAssertEqual(undated.dated(timeZone: berlin)[2].startDate, "2027-06-12")
    }

    func testTakingTheTicketOffMovesNothingAndTheTicketIsSent() throws {
        var draft = chain
        let journey = draft.items[2].id
        draft.setTicket(journey, day: "2027-06-05", timeZone: berlin)
        let data = try JSONEncoder().encode(draft.request)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let items = try XCTUnwrap(json["items"] as? [[String: Any]])
        XCTAssertEqual(items[2]["pinnedStart"] as? String, "2027-06-05")

        draft.setTicket(journey, day: nil, timeZone: berlin)
        XCTAssertFalse(draft[journey]?.isTicketed == true)
        XCTAssertEqual(draft.items[1].days, 3)
        XCTAssertEqual(draft.dated(timeZone: berlin)[3].startDate, "2027-06-05")
    }
}
