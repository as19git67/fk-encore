import XCTest
@testable import FKPhotosLib

/// A journey between two legs (§22.7): which leg is being lived on the
/// day three of them share, how long the trip is, and what the journey
/// screen sends.
final class TripTransitTests: XCTestCase {

    private let berlin = TimeZone(identifier: "Europe/Berlin")!

    private func day(_ index: Int, departureAt: Int? = nil, extra: [TripFixpoint] = []) -> TripDay {
        let departure = departureAt.map {
            TripFixpoint(rowId: 1, kind: "departure", label: "Abfahrt", startMinutes: $0,
                         durationMinutes: 0, travelMinutes: 0, bufferMinutes: 5, lat: nil, lon: nil)
        }
        return TripDay(id: index + 10, dayIndex: index, detailed: true, bufferReason: nil, blocks: [],
                       fixpoints: (departure.map { [$0] } ?? []) + extra)
    }

    private func leg(_ position: Int, start: String?, days: [TripDay], arrive: Int? = nil,
                     transit: (depart: Int, end: Int)? = nil) -> TripLeg {
        var leg = TripLeg(
            id: position + 1, position: position, title: "Ort \(position)",
            anchor: TripCoordinate(lat: 48.37, lon: 10.9 + Double(position)),
            anchorRadiusM: nil, anchorLabel: nil, arriveMinutes: arrive, mode: "car", regionDb: "nom_x",
            awaitingRegion: nil, startDate: start, days: days, pool: [],
        )
        if let transit {
            leg.kind = "transit"
            leg.departMinutes = transit.depart
            leg.endMinutes = transit.end
        }
        return leg
    }

    /// Staying 5.–6., the journey on the 6th from 10:00 to 16:00,
    /// staying 6.–7. from the arrival.
    private var plan: TripPlan {
        TripPlan(id: 1, ownerId: 1, title: "Mit Weiterreise", constraints: nil, legs: [
            leg(0, start: "2026-09-05", days: [day(0), day(1, departureAt: 600)]),
            leg(1, start: "2026-09-06", days: [day(0, departureAt: 960)], transit: (600, 960)),
            leg(2, start: "2026-09-06", days: [day(0), day(1)], arrive: 960),
        ])
    }

    private func at(_ isoDay: String, _ minutes: Int) -> Date {
        TripTransitPlanning.moment(isoDay, minutes: minutes, timeZone: berlin)!
    }

    func testTheDayOfAJourneyBelongsToThreeLegsByTheClock() {
        XCTAssertEqual(plan.position(on: at("2026-09-06", 540), timeZone: berlin)?.legIndex, 0)
        XCTAssertEqual(plan.position(on: at("2026-09-06", 720), timeZone: berlin)?.legIndex, 1)
        XCTAssertEqual(plan.position(on: at("2026-09-06", 1000), timeZone: berlin)?.legIndex, 2)
        XCTAssertEqual(plan.position(on: at("2026-09-07", 600), timeZone: berlin)?.dayIndex, 1)
    }

    func testTheTripIsAsLongAsTheCalendarSays() {
        // Three calendar days, although the legs' days add up to five.
        XCTAssertEqual(plan.calendarDayCount, 3)
    }

    func testAJourneyIsOfferedBetweenTwoPlaces() {
        let stays = [
            leg(0, start: "2026-09-05", days: [day(0)]),
            leg(1, start: "2026-09-06", days: [day(0)]),
        ]
        XCTAssertEqual(TripTransitSlots.slotAfter(stays[0], in: stays), 0)
        XCTAssertNil(TripTransitSlots.slotAfter(stays[1], in: stays))
        // With a journey already there, not again.
        XCTAssertNil(TripTransitSlots.slotAfter(plan.legs[0], in: plan.legs))
    }

    func testTheScreenSendsTheTwoMomentsOnThePhonesClock() {
        let body = TripTransitPlanning.body(afterLegIndex: 0, depart: at("2026-09-06", 600),
                                            arrive: at("2026-09-07", 90), mode: .car, timeZone: berlin)
        XCTAssertEqual(body, .init(afterLegIndex: 0, departDate: "2026-09-06", departAt: "10:00",
                                   arriveDate: "2026-09-07", arriveAt: "01:30", mode: "car"))
        // Changing sends the moments without the neighbour's position.
        XCTAssertEqual(body.change, .init(departDate: "2026-09-06", departAt: "10:00",
                                          arriveDate: "2026-09-07", arriveAt: "01:30", mode: "car"))
    }

    func testTheWindowOfAJourneyReadsAsFromTo() {
        XCTAssertEqual(plan.legs[1].transitWindowText, "10:00 → 16:00")
        XCTAssertNil(plan.legs[0].transitWindowText)
    }

    func testTheSuggestionDecodesAndItsClockReads() throws {
        let json = """
        {"suggestion":{"afterLegIndex":0,"fromTitle":"Ort 0","toTitle":"Ort 1",
         "departDate":"2026-09-06","departAt":"10:00","arriveDate":"2026-09-06","arriveAt":"16:30",
         "mode":"car","driveMinutes":200,"sentence":"Von Ort 0 nach Ort 1 sind es rund 3 h 20."}}
        """
        let response = try JSONDecoder().decode(TripTransitSuggestionResponse.self, from: Data(json.utf8))
        let suggestion = try XCTUnwrap(response.suggestion)
        XCTAssertEqual(suggestion.afterLegIndex, 0)
        XCTAssertEqual(TripTransitPlanning.minutes(fromClock: suggestion.arriveAt), 990)
        XCTAssertNil(TripTransitPlanning.minutes(fromClock: "25:00"))
        XCTAssertNotEqual(TripTransitSuggestion.dismissKey(planId: 1, afterLegIndex: 0),
                          TripTransitSuggestion.dismissKey(planId: 1, afterLegIndex: 1))
    }

    func testTheWayThereAndHomeAreOfferedOnlyWithAHome() {
        let stays = [
            leg(0, start: "2026-09-05", days: [day(0)]),
            leg(1, start: "2026-09-06", days: [day(0)]),
        ]
        XCTAssertFalse(TripTransitSlots.wantsArrival(stays, hasHome: false))
        XCTAssertNil(TripTransitSlots.wantsReturn(stays, hasHome: false))
        XCTAssertTrue(TripTransitSlots.wantsArrival(stays, hasHome: true))
        XCTAssertEqual(TripTransitSlots.wantsReturn(stays, hasHome: true), 1)
        // Already beginning with a journey: not again.
        var journeyFirst = stays
        journeyFirst.insert(leg(-1, start: "2026-09-05", days: [day(0)], transit: (480, 720)), at: 0)
        XCTAssertFalse(TripTransitSlots.wantsArrival(journeyFirst, hasHome: true))
    }

    func testJourneysAreOfferedOnAnUndatedTrip() {
        let stays = [
            leg(0, start: nil, days: [day(0)]),
            leg(1, start: nil, days: [day(0)]),
        ]
        XCTAssertTrue(TripTransitSlots.wantsArrival(stays, hasHome: true))
        XCTAssertEqual(TripTransitSlots.wantsReturn(stays, hasHome: true), 1)
        XCTAssertEqual(TripTransitSlots.slotAfter(stays[0], in: stays), 0)
        XCTAssertEqual(TripTransitPlanning.frameSentence(from: nil, to: "Ort 0", undated: true),
                       "„Ort 0“ beginnt mit der Ankunft. Alle Etappen danach verschieben sich mit. "
                       + "Die Reise bekommt damit ihr Datum.")
    }

    func testTheFrameSentenceNamesWhatMoves() {
        XCTAssertEqual(TripTransitPlanning.frameSentence(from: nil, to: "Ort 0"),
                       "„Ort 0“ beginnt mit der Ankunft. Alle Etappen danach verschieben sich mit.")
        XCTAssertEqual(TripTransitPlanning.frameSentence(from: "Ort 2", to: nil),
                       "„Ort 2“ endet mit der Abfahrt.")
    }

    func testAHomeDecodesAndAnOlderServerWithoutOneStillDoes() throws {
        let with = """
        {"id":1,"ownerId":1,"title":null,"constraints":null,"legs":[],
         "home":{"lat":48.5,"lon":10.55,"label":"Zuhause"}}
        """
        let without = """
        {"id":1,"ownerId":1,"title":null,"constraints":null,"legs":[]}
        """
        XCTAssertEqual(try JSONDecoder().decode(TripPlan.self, from: Data(with.utf8)).home?.displayLabel, "Zuhause")
        XCTAssertNil(try JSONDecoder().decode(TripPlan.self, from: Data(without.utf8)).home)
    }
}
