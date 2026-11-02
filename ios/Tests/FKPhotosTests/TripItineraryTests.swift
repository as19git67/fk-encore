import XCTest
@testable import FKPhotosLib

/// The chain the itinerary screen edits (documentation/plans/reiseverlauf.md,
/// stage 2): what inserting, removing and moving a stay do to the
/// journeys around it, which dates follow from the one date, and what
/// goes over the wire.
final class TripItineraryTests: XCTestCase {

    private let berlin = TimeZone(identifier: "Europe/Berlin")!

    private func stay(_ title: String, days: Int, legId: Int? = nil, mode: TripTransportMode = .foot) -> TripItineraryItem {
        var item = TripItineraryItem(kind: .stay)
        item.title = title
        item.legId = legId
        item.days = days
        item.mode = mode.rawValue
        item.anchor = TripCoordinate(lat: 48.1, lon: 11.5)
        item.anchorLabel = "Hotel \(title)"
        return item
    }

    private func journey(departAt: String? = nil, arriveAt: String? = nil, nights: Int = 0,
                         legId: Int? = nil, mode: TripTransportMode = .car) -> TripItineraryItem {
        var item = TripItineraryItem(kind: .journey)
        item.departAt = departAt
        item.arriveAt = arriveAt
        item.nights = nights
        item.legId = legId
        item.mode = mode.rawValue
        return item
    }

    /// Three days in A, a journey by day, two days in B.
    private var twoStays: TripItineraryDraft {
        TripItineraryDraft(startDate: "2027-06-03", hasHome: false, items: [
            stay("Ort A", days: 3, legId: 1),
            journey(departAt: "10:00", arriveAt: "15:00", legId: 2),
            stay("Ort B", days: 2, legId: 3),
        ])
    }

    // MARK: - Where the screen opens (stage 3)

    func testALegOpensOnItsOwnCard() {
        let draft = twoStays
        XCTAssertEqual(draft.item(focused: .leg(2))?.legId, 2)
        XCTAssertEqual(draft.item(focused: .leg(3))?.legId, 3)
        XCTAssertNil(draft.item(focused: .leg(99)))
    }

    func testTheArrivalAtAStayIsTheJourneyBeforeIt() {
        let draft = twoStays
        // The journey into B is the transit leg between the two stays.
        XCTAssertEqual(draft.item(focused: .journeyBefore(legId: 3))?.legId, 2)
        // The departure from A is that same journey.
        XCTAssertEqual(draft.item(focused: .journeyAfter(legId: 1))?.legId, 2)
    }

    func testWithoutAJourneyBeforeTheFirstStayItsOwnCardOpens() {
        // No home known: nothing leads into the first stay, so its
        // arrival is the stay's own and the stay unfolds.
        let draft = twoStays
        XCTAssertEqual(draft.item(focused: .journeyBefore(legId: 1))?.legId, 1)
        XCTAssertEqual(draft.item(focused: .journeyAfter(legId: 3))?.legId, 3)
    }

    func testWithHomeTheWayThereAndBackAreJourneys() {
        let draft = TripItineraryDraft(startDate: nil, hasHome: true, items: [
            stay("Ort A", days: 3, legId: 1),
            journey(legId: nil),
            stay("Ort B", days: 2, legId: 3),
        ])
        let outward = draft.item(focused: .journeyBefore(legId: 1))
        XCTAssertEqual(outward?.kind, .journey)
        XCTAssertEqual(outward?.id, draft.items.first?.id)
        let homeward = draft.item(focused: .journeyAfter(legId: 3))
        XCTAssertEqual(homeward?.kind, .journey)
        XCTAssertEqual(homeward?.id, draft.items.last?.id)
    }

    // MARK: - Dates

    func testTheDatesFollowFromTheFirstDayAndTheLengths() {
        let dated = twoStays.dated(timeZone: berlin)
        XCTAssertEqual(dated.map(\.startDate), ["2027-06-03", "2027-06-05", "2027-06-05"])
        XCTAssertEqual(dated.map(\.endDate), ["2027-06-05", "2027-06-05", "2027-06-06"])
        XCTAssertEqual(twoStays.lastDate, "2027-06-06")
    }

    func testANightOnTheWayMovesTheNextStayByADay() {
        var draft = twoStays
        var overnight = draft.items[1]
        overnight.nights = 1
        draft[overnight.id] = overnight
        let dated = draft.dated(timeZone: berlin)
        XCTAssertEqual(dated[1].endDate, "2027-06-06")
        XCTAssertEqual(dated[2].startDate, "2027-06-06")
        XCTAssertEqual(dated[2].endDate, "2027-06-07")
    }

    func testALongerStayMovesEverythingAfterIt() {
        var draft = twoStays
        var first = draft.items[0]
        first.days = 4
        draft[first.id] = first
        XCTAssertEqual(draft.dated(timeZone: berlin)[2].startDate, "2027-06-06")
    }

    func testWithoutADateTheDaysAreCounted() {
        var draft = twoStays
        draft.startDate = nil
        XCTAssertTrue(draft.dated().allSatisfy { $0.startDate == nil && $0.endDate == nil })
        let offsets = TripItineraryText.dayOffsets(of: draft)
        XCTAssertEqual(offsets.map(\.first), [0, 2, 2])
        XCTAssertEqual(offsets.map(\.last), [2, 2, 3])
        XCTAssertEqual(TripItineraryText.span(draft.dated()[0], dayOffsets: offsets[0]), "Tag 1 – 3")
        XCTAssertEqual(TripItineraryText.span(draft.dated()[1], dayOffsets: offsets[1]), "Tag 3")
    }

    // MARK: - The chain stays a chain

    func testTwoStaysSideBySideGetAJourneyBetweenThem() {
        let draft = TripItineraryDraft(startDate: nil, hasHome: false, items: [
            stay("Ort A", days: 2), stay("Ort B", days: 2),
        ])
        XCTAssertEqual(draft.items.map(\.kind), [.stay, .journey, .stay])
        XCTAssertNil(draft.items[1].departAt)
        XCTAssertNil(draft.items[1].arriveAt)
    }

    func testHomeBringsTheWayThereAndTheWayHome() {
        var draft = twoStays
        XCTAssertEqual(draft.items.count, 3)
        draft.setHome("Daheim")
        XCTAssertEqual(draft.items.map(\.kind), [.journey, .stay, .journey, .stay, .journey])
        XCTAssertEqual(draft.ends(of: draft.items[0]).from, "Daheim")
        XCTAssertEqual(draft.ends(of: draft.items[0]).to, "Ort A")
        XCTAssertEqual(draft.ends(of: draft.items[4]).to, "Daheim")
        // Taking home off takes the two journeys off again.
        draft.setHome(nil)
        XCTAssertEqual(draft.items.map(\.kind), [.stay, .journey, .stay])
    }

    func testTheWayThereLeavesOnTheFirstDay() {
        var draft = twoStays
        draft.setHome("Daheim")
        let dated = draft.dated(timeZone: berlin)
        XCTAssertEqual(dated[0].startDate, "2027-06-03")
        XCTAssertEqual(dated[0].endDate, "2027-06-03")
        XCTAssertEqual(dated[1].startDate, "2027-06-03")
    }

    func testInsertingAStayBringsItsJourneyWithIt() {
        var draft = twoStays
        let newId = draft.insertStay(after: draft.items[0].id)
        XCTAssertEqual(draft.items.map(\.kind), [.stay, .journey, .stay, .journey, .stay])
        XCTAssertEqual(draft.items[2].id, newId)
        // The new stay borrows the length and mode of the one before.
        XCTAssertEqual(draft.items[2].days, 3)
        XCTAssertEqual(draft.items[2].mode, "foot")
        XCTAssertNil(draft.items[2].anchor)
        // The journey into it is open; the one out of it is the old one.
        XCTAssertNil(draft.items[1].departAt)
        XCTAssertEqual(draft.items[3].legId, 2)
        // At the very beginning, with a journey after it.
        let firstId = draft.insertStay(after: nil)
        XCTAssertEqual(draft.items.first?.id, firstId)
        XCTAssertEqual(draft.items[1].kind, .journey)
        XCTAssertEqual(draft.stayCount, 4)
    }

    func testRemovingAStayMergesTheTwoJourneysAroundIt() {
        var draft = twoStays
        draft.insertStay(after: draft.items[0].id)
        var into = draft.items[1]
        into.departAt = "09:00"
        draft[into.id] = into
        // A, (09:00 →) new, (10:00 → 15:00) B: taking the new one out
        // leaves one journey from A at 09:00 arriving 15:00 in B.
        draft.removeStay(id: draft.items[2].id)
        XCTAssertEqual(draft.items.map(\.kind), [.stay, .journey, .stay])
        XCTAssertEqual(draft.items[1].departAt, "09:00")
        XCTAssertEqual(draft.items[1].arriveAt, "15:00")
        XCTAssertEqual(draft.items[2].title, "Ort B")
    }

    func testRemovingTheFirstOrLastStayTakesItsJourneyAlong() {
        var draft = twoStays
        draft.removeStay(id: draft.items[0].id)
        XCTAssertEqual(draft.items.map(\.title), ["Ort B"])
        // The only stay cannot be removed.
        draft.removeStay(id: draft.items[0].id)
        XCTAssertEqual(draft.stayCount, 1)
        var other = twoStays
        other.removeStay(id: other.items[2].id)
        XCTAssertEqual(other.items.map(\.title), ["Ort A"])
    }

    func testMovingStaysKeepsTheJourneysInTheirSlots() {
        var draft = twoStays
        draft.insertStay(after: draft.items[2].id)
        var third = draft.items[4]
        third.title = "Ort C"
        third.anchor = TripCoordinate(lat: 1, lon: 1)
        draft[third.id] = third
        draft.moveStays(fromOffsets: IndexSet(integer: 2), toOffset: 0)
        XCTAssertEqual(draft.stays.map(\.title), ["Ort C", "Ort A", "Ort B"])
        XCTAssertEqual(draft.items.map(\.kind), [.stay, .journey, .stay, .journey, .stay])
        // The timed journey still sits between the first and the second stay.
        XCTAssertEqual(draft.items[1].legId, 2)
    }

    // MARK: - Refusals, said before the server would

    func testAStayWithoutAPlaceAndAJourneyArrivingBeforeItLeavesAreNamed() {
        var draft = twoStays
        draft.insertStay(after: nil)
        var backwards = draft.items[3]
        backwards.departAt = "16:00"
        backwards.arriveAt = "15:00"
        draft[backwards.id] = backwards
        let problems = draft.problems()
        XCTAssertEqual(problems.count, 2)
        XCTAssertTrue(problems[0].contains("Aufenthalt 1 hat noch keinen Ort"))
        XCTAssertTrue(problems[1].contains("von Ort A nach Ort B"))
        // With a night on the way the same clock times are fine.
        backwards.nights = 1
        draft[backwards.id] = backwards
        XCTAssertEqual(draft.problems().count, 1)
    }

    // MARK: - Words

    func testDaysAndNightsReadSideBySide() {
        XCTAssertEqual(TripItineraryText.stayLength(days: 1), "1 Tag · keine Nacht")
        XCTAssertEqual(TripItineraryText.stayLength(days: 2), "2 Tage · 1 Nacht")
        XCTAssertEqual(TripItineraryText.stayLength(days: 4), "4 Tage · 3 Nächte")
    }

    func testAJourneyLineSaysWhatIsKnown() {
        XCTAssertEqual(TripItineraryText.journeyLine(journey(departAt: "10:00", arriveAt: "15:00", mode: .transit)),
                       "ab 10:00 · an 15:00 · ÖPNV & zu Fuß")
        XCTAssertEqual(TripItineraryText.journeyLine(journey(mode: .car)), "Zeiten offen · mit dem Auto")
        XCTAssertEqual(TripItineraryText.journeyLine(journey(departAt: "22:00", arriveAt: "08:00", nights: 1, mode: .ship)),
                       "ab 22:00 · an 08:00 · mit dem Schiff · 1 Nacht unterwegs")
    }

    func testAStayIsNamedByItsTitleThenItsLodgingThenItsNumber() {
        var nameless = stay("", days: 1)
        nameless.title = nil
        let draft = TripItineraryDraft(startDate: nil, hasHome: false, items: [nameless, stay("Ort B", days: 1)])
        XCTAssertEqual(draft.title(of: draft.items[0]), "Hotel")
        var bare = draft.items[0]
        bare.anchorLabel = nil
        XCTAssertEqual(draft.title(of: bare), "Aufenthalt 1")
        XCTAssertEqual(draft.title(of: draft.items[2]), "Ort B")
    }

    // MARK: - The wire

    func testTheResponseDecodesAndTheRequestSaysWhatWasTakenOff() throws {
        let json = """
        {"planId":7,"startDate":"2027-06-03","home":{"lat":48.5,"lon":10.5,"label":"Daheim"},
         "items":[
          {"kind":"journey","departAt":null,"arriveAt":"14:00","nights":0,"mode":"car","startDate":"2027-06-03","endDate":"2027-06-03"},
          {"kind":"stay","legId":1,"title":"Ort A","anchor":{"lat":48.1,"lon":11.5},"anchorLabel":"Hotel A",
           "anchorRadiusM":1000,"mode":"foot","days":3,"radiusM":3000,"quartersAboard":false,"tenderPort":false,
           "startDate":"2027-06-03","endDate":"2027-06-05"},
          {"kind":"journey","departAt":null,"arriveAt":null,"nights":0,"mode":"car","startDate":"2027-06-05","endDate":"2027-06-05"}
         ]}
        """
        let response = try JSONDecoder().decode(TripItineraryResponse.self, from: Data(json.utf8))
        var draft = TripItineraryDraft(response: response)
        XCTAssertEqual(draft.items.map(\.kind), [.journey, .stay, .journey])
        XCTAssertEqual(draft.items[1].anchorRadiusM, 1000)
        XCTAssertEqual(draft.homeLabel, "Daheim")

        // Something got booked: the radius comes off, as an explicit null.
        var booked = draft.items[1]
        booked.anchorRadiusM = nil
        draft[booked.id] = booked
        let encoded = try JSONEncoder().encode(draft.request)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(object["startDate"] as? String, "2027-06-03")
        let items = try XCTUnwrap(object["items"] as? [[String: Any]])
        XCTAssertEqual(items.count, 3)
        XCTAssertTrue(items[1]["anchorRadiusM"] is NSNull)
        XCTAssertEqual(items[1]["legId"] as? Int, 1)
        XCTAssertEqual(items[1]["days"] as? Int, 3)
        // The derived dates never go back.
        XCTAssertNil(items[1]["startDate"])
        XCTAssertNil(items[1]["endDate"])
        // A journey without times says so with nulls, and its nights.
        XCTAssertTrue(items[0]["departAt"] is NSNull)
        XCTAssertEqual(items[0]["arriveAt"] as? String, "14:00")
        XCTAssertEqual(items[2]["nights"] as? Int, 0)

        // Taking the date off is a null too, not an absent key.
        draft.startDate = nil
        let undated = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(draft.request)) as? [String: Any])
        XCTAssertTrue(undated["startDate"] is NSNull)
    }
}

/// Which of a day's fixed times are a journey's, and so lead into the
/// itinerary rather than offering an x (stage 3).
final class TripLegItineraryFocusTests: XCTestCase {

    private let base = TripCoordinate(lat: 48.37, lon: 10.9)

    private func fix(_ kind: String, at minutes: Int, lat: Double? = nil, lon: Double? = nil) -> TripFixpoint {
        TripFixpoint(rowId: minutes, kind: kind, label: kind, startMinutes: minutes, durationMinutes: 0,
                     travelMinutes: 0, bufferMinutes: 0, lat: lat, lon: lon)
    }

    private func day(_ index: Int, _ fixpoints: [TripFixpoint]) -> TripDay {
        TripDay(id: index + 10, dayIndex: index, detailed: true, bufferReason: nil, blocks: [], fixpoints: fixpoints)
    }

    private func leg(days: [TripDay], transit: (depart: Int, end: Int)? = nil) -> TripLeg {
        var leg = TripLeg(
            id: 7, position: 0, title: "Ort", anchor: base, anchorRadiusM: nil, anchorLabel: nil,
            arriveMinutes: nil, mode: "car", regionDb: "nom_x", awaitingRegion: nil, startDate: nil,
            days: days, pool: [],
        )
        if let transit {
            leg.kind = "transit"
            leg.departMinutes = transit.depart
            leg.endMinutes = transit.end
        }
        return leg
    }

    func testTheDepartureAJourneyWroteOnAStaysLastDayLeadsToThatJourney() {
        // `journeyDeparture` writes the departure at the base itself.
        let departure = fix("departure", at: 600, lat: base.lat, lon: base.lon)
        let leg = leg(days: [day(0, []), day(1, [departure])])
        XCTAssertTrue(leg.isJourneyDeparture(departure, dayIndex: 1))
        XCTAssertEqual(leg.itineraryFocus(for: departure, dayIndex: 1), .journeyAfter(legId: 7))
        // Not on an earlier day: a departure there is the day's own.
        XCTAssertNil(leg.itineraryFocus(for: departure, dayIndex: 0))
    }

    func testADepartureSomewhereElseIsTheDaysOwn() {
        // A train from the station, entered by hand (§4.4): the x stays.
        let train = fix("departure", at: 1120, lat: base.lat + 0.02, lon: base.lon)
        let leg = leg(days: [day(0, [train])])
        XCTAssertNil(leg.itineraryFocus(for: train, dayIndex: 0))
        XCTAssertNil(leg.itineraryFocus(for: fix("appointment", at: 600, lat: base.lat, lon: base.lon), dayIndex: 0))
    }

    func testATransitLegsEndsLeadToItsOwnCard() {
        let depart = fix("appointment", at: 600)
        let arrive = fix("departure", at: 960)
        let leg = leg(days: [day(0, [depart]), day(1, [arrive])], transit: (600, 960))
        XCTAssertEqual(leg.itineraryFocus(for: depart, dayIndex: 0), .leg(7))
        XCTAssertEqual(leg.itineraryFocus(for: arrive, dayIndex: 1), .leg(7))
        // A journey's own anchor is never read as a stay's departure.
        XCTAssertFalse(leg.isJourneyDeparture(fix("departure", at: 960, lat: base.lat, lon: base.lon), dayIndex: 1))
    }
}
