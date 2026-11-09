import XCTest
@testable import FKPhotosLib

/// Stage 2 of documentation/plans/reise-planen-und-unterwegs.md: the
/// itinerary shows the days under each stay, puts ports into a ship
/// journey without moving the end of the trip, and knows a port between
/// two ships sleeps aboard.
final class TripItineraryStayDaysTests: XCTestCase {

    private func stay(_ title: String, days: Int) -> TripItineraryItem {
        var item = TripItineraryItem(kind: .stay)
        item.title = title
        item.days = days
        item.mode = TripTransportMode.foot.rawValue
        item.anchor = TripCoordinate(lat: 48.1, lon: 11.5)
        return item
    }

    private func journey(_ mode: TripTransportMode, departAt: String? = nil, arriveAt: String? = nil,
                         nights: Int = 0) -> TripItineraryItem {
        var item = TripItineraryItem(kind: .journey)
        item.mode = mode.rawValue
        item.departAt = departAt
        item.arriveAt = arriveAt
        item.nights = nights
        return item
    }

    /// Embarkation, twelve nights at sea, disembarkation.
    private var cruise: TripItineraryDraft {
        TripItineraryDraft(startDate: "2026-11-26", hasHome: false, items: [
            stay("Inselhafen", days: 1),
            journey(.ship, departAt: "18:00", arriveAt: "08:00", nights: 12),
            stay("Inselhafen", days: 1),
        ])
    }

    // MARK: - Ports

    func testAPortSplitsTheShipJourneyAndKeepsTheEnd() {
        var draft = cruise
        let end = draft.lastDate
        let ship = draft.items[1].id
        let port = draft.insertPort(into: ship, ashoreAfter: 1, days: 2, ashoreFrom: "08:00", aboardUntil: "22:00")
        XCTAssertNotNil(port)
        XCTAssertEqual(draft.items.map(\.kind), [.stay, .journey, .stay, .journey, .stay])
        XCTAssertEqual(draft.items[1].id, ship, "the first half keeps the journey")
        XCTAssertEqual(draft.items[1].arriveAt, "08:00")
        XCTAssertEqual(draft.items[1].nights, 1)
        XCTAssertEqual(draft.items[2].days, 2)
        XCTAssertEqual(draft.items[3].departAt, "22:00")
        XCTAssertEqual(draft.items[3].arriveAt, "08:00")
        XCTAssertEqual(draft.items[3].nights, 10)
        XCTAssertEqual(draft.items[3].transportMode, .ship)
        XCTAssertEqual(draft.lastDate, end)
        XCTAssertTrue(draft.isBetweenShips(draft.items[2].id))
        XCTAssertFalse(draft.isBetweenShips(draft.items[0].id))
    }

    func testAPortThatDoesNotFitIsRefused() {
        var draft = cruise
        let ship = draft.items[1].id
        XCTAssertNil(draft.insertPort(into: ship, ashoreAfter: 10, days: 4, ashoreFrom: "08:00", aboardUntil: "18:00"))
        // Ashore before the ship has left.
        XCTAssertNil(draft.insertPort(into: ship, ashoreAfter: 0, days: 1, ashoreFrom: "17:00", aboardUntil: "20:00"))
        // Aboard again before going ashore, on a one-day port.
        XCTAssertNil(draft.insertPort(into: ship, ashoreAfter: 2, days: 1, ashoreFrom: "09:00", aboardUntil: "08:00"))
        XCTAssertEqual(draft.items.count, 3, "nothing changed")
    }

    func testAShipMayCarryTheSeaDaysOfACruise() {
        XCTAssertEqual(TripItineraryDraft.maxNights(for: .ship), 30)
        XCTAssertEqual(TripItineraryDraft.maxNights(for: .car), 6)
    }

    // MARK: - Words

    func testTheClockJumpIsSaidInHours() {
        XCTAssertEqual(TripItineraryText.zoneShift(480), "+8 h")
        XCTAssertEqual(TripItineraryText.zoneShift(-420), "−7 h")
        XCTAssertEqual(TripItineraryText.zoneShift(330), "+5 h 30")
        XCTAssertNil(TripItineraryText.zoneShift(0))
        XCTAssertNil(TripItineraryText.zoneShift(nil))
    }

    func testATripWithoutADateCountsItsDays() {
        let draft = TripItineraryDraft(startDate: nil, hasHome: false, items: [
            stay("Musterstadt", days: 3),
        ])
        XCTAssertEqual(draft.totalDays, 3)
        XCTAssertEqual(TripItineraryText.tripSpan(draft), "Noch ohne Datum · 3 Tage")
    }

    func testJourneysAreNamedByWhereTheyLead() {
        let draft = TripItineraryDraft(startDate: nil, hasHome: true, items: [
            stay("Ort A", days: 2),
            journey(.ship),
            stay("Ort B", days: 2),
        ])
        XCTAssertEqual(draft.name(of: draft.items[0]), "Anreise")
        XCTAssertEqual(draft.name(of: draft.items[2]), "Schiff")
        XCTAssertEqual(draft.name(of: draft.items[4]), "Heimreise")
        XCTAssertEqual(draft.outbound?.id, draft.items[0].id)
        XCTAssertFalse(draft.ownsStart(draft.items[1].id), "the way there owns the start")
    }

    // MARK: - Days under a stay

    func testTheDaysOfAStayCarryArrivalDepartureAndFill() {
        let draft = TripItineraryDraft(startDate: "2026-11-27", hasHome: false, items: [
            stay("Inselhafen", days: 3),
        ])
        let dated = draft.dated()[0]
        var full = TripDay(id: 1, dayIndex: 0, detailed: true, bufferReason: nil, blocks: [], fixpoints: [])
        full.window = TripDayWindow(startMinutes: 750, endMinutes: 1050)
        full.plannedMinutes = 330
        full.overrunMinutes = 30
        var half = TripDay(id: 2, dayIndex: 1, detailed: true, bufferReason: nil, blocks: [], fixpoints: [])
        half.window = TripDayWindow(startMinutes: 540, endMinutes: 1140)
        half.plannedMinutes = 300
        let rows = TripItineraryDays.rows(stay: draft.items[0], dated: dated, days: [half, full],
                                          arrival: "12:30", departure: "10:00")
        XCTAssertEqual(rows.map(\.number), [1, 2, 3])
        XCTAssertEqual(rows.map(\.dayIndex), [0, 1, nil])
        XCTAssertTrue(rows[0].label.hasPrefix("Tag 1 · "))
        XCTAssertTrue(rows[0].label.hasSuffix("an 12:30"))
        XCTAssertTrue(rows[2].label.hasSuffix("ab 10:00"))
        XCTAssertEqual(rows[0].summary, "zu viel")
        XCTAssertTrue(rows[0].isOverfull)
        XCTAssertEqual(rows[1].fill ?? 0, 0.5, accuracy: 0.001)
        XCTAssertEqual(rows[2].summary, "noch frei")
        XCTAssertEqual(rows[2].fill, 0)
    }

    func testDaysWithoutADateAreOnlyNumbered() {
        let draft = TripItineraryDraft(startDate: nil, hasHome: false, items: [stay("Musterstadt", days: 2)])
        let rows = TripItineraryDays.rows(stay: draft.items[0], dated: draft.dated()[0], days: [],
                                          arrival: nil, departure: nil)
        XCTAssertEqual(rows.map(\.label), ["Tag 1", "Tag 2"])
    }
}
