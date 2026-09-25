import CoreLocation
import XCTest
@testable import FKPhotosLib

/// The day noticing that it is not going to plan (§7.1) — the pure
/// rules behind the cards and the banners. What woke the app, and
/// what the banner then does, is CoreLocation and UIKit and is not
/// tested here.
final class TripBehindCheckTests: XCTestCase {

    private func stop(_ id: Int, dwell: Int, travel: Int = 0, status: String = "planned") -> TripStop {
        TripStop(
            rowId: id, osmRef: "node:\(id)", name: "Ort \(id)", lat: 45.88, lon: 10.84,
            category: "sight", dwellMinutes: dwell,
            travelFromPrevious: TripTravel(minutes: travel, distanceM: travel * 75, travelClass: "short_walk"),
            status: status, pinned: false, note: nil, sourceUrl: nil, title: nil, localName: nil,
            wikipediaUrl: nil, photoStop: nil,
        )
    }

    private func block(_ id: String, start: Int?, budget: Int, stops: [TripStop]) -> TripBlock {
        TripBlock(
            id: id, rowId: id.hashValue, label: id, kind: "spots", budgetMinutes: budget,
            usedMinutes: stops.reduce(0) { $0 + $1.dwellMinutes + $1.travelFromPrevious.minutes },
            startMinutes: start, stops: stops, branches: nil,
        )
    }

    private func day(_ blocks: [TripBlock]) -> TripDay {
        TripDay(id: 1, dayIndex: 0, detailed: true, bufferReason: nil, blocks: blocks, fixpoints: [])
    }

    func testItAsksTheHeuristicsQuestionOfTheBlockTheClockIsIn() throws {
        // Afternoon 14:00–17:00, two stops open of three, at 16:00.
        let afternoon = block("afternoon", start: 14 * 60, budget: 180, stops: [
            stop(1, dwell: 60, status: "done"),
            stop(2, dwell: 45, travel: 10),
            stop(3, dwell: 45, travel: 15),
        ])
        let found = try XCTUnwrap(TripBehindCheck.situation(day: day([afternoon]), at: 16 * 60, alreadySuggested: { _ in false }))
        XCTAssertEqual(found.block.id, "afternoon")
        XCTAssertEqual(found.situation.elapsedMinutes, 120)
        XCTAssertEqual(found.situation.remainingMinutes, 60)
        // Done stops are not work that is left.
        XCTAssertEqual(found.situation.remainingWorkMinutes, 115)
        XCTAssertEqual(found.situation.remainingStops, 2)
        XCTAssertFalse(found.situation.alreadySuggested)
        // And the heuristic, fed this, offers.
        if case .offer = TripArrivalHeuristic.evaluate(found.situation) {} else {
            XCTFail("two hours behind with an hour left should be an offer")
        }
    }

    func testOutsideEveryBlockThereIsNothingToBeBehindOn() {
        let afternoon = block("afternoon", start: 14 * 60, budget: 180, stops: [stop(1, dwell: 60)])
        XCTAssertNil(TripBehindCheck.situation(day: day([afternoon]), at: 9 * 60, alreadySuggested: { _ in false }))
        XCTAssertNil(TripBehindCheck.situation(day: day([afternoon]), at: 18 * 60, alreadySuggested: { _ in false }))
    }

    func testAPlanWithoutBlockTimesIsQuiet() {
        // Honesty rule (§8.3): no clock, no claim.
        let untimed = block("afternoon", start: nil, budget: 180, stops: [stop(1, dwell: 60)])
        XCTAssertNil(TripBehindCheck.situation(day: day([untimed]), at: 16 * 60, alreadySuggested: { _ in false }))
    }

    func testWhatWasAlreadyAskedIsCarriedIn() throws {
        let afternoon = block("afternoon", start: 14 * 60, budget: 180, stops: [stop(1, dwell: 60)])
        let found = try XCTUnwrap(TripBehindCheck.situation(day: day([afternoon]), at: 16 * 60, alreadySuggested: { $0 == "afternoon" }))
        XCTAssertTrue(found.situation.alreadySuggested)
    }
}

/// The arrival day's rule (§4.2, §5): arrived later than planned.
final class TripLateArrivalTests: XCTestCase {

    private func situation(
        arrive: Int? = 12 * 60,
        now: Int = 17 * 60,
        firstDay: Bool = true,
        settled: Int = 0,
        atQuarters: Bool = true,
        asked: Bool = false,
    ) -> TripLateArrival.Situation {
        TripLateArrival.Situation(
            arriveMinutes: arrive, nowMinutes: now, isFirstDayOfLeg: firstDay,
            settledStops: settled, atQuarters: atQuarters, alreadyAsked: asked,
        )
    }

    func testFiveHoursLateAtTheHotelIsAnOffer() {
        // The trial's own case: arrival set for noon, the car pulled up
        // at five.
        XCTAssertEqual(TripLateArrival.evaluate(situation()), .offer(certain: true))
    }

    func testLateButNotYetThereIsAQuestionNotAStatement() {
        XCTAssertEqual(TripLateArrival.evaluate(situation(atQuarters: false)), .offer(certain: false))
    }

    func testHalfAnHourIsACheckInNotALostAfternoon() {
        XCTAssertEqual(TripLateArrival.evaluate(situation(now: 12 * 60 + 29)), .quiet)
        XCTAssertEqual(TripLateArrival.evaluate(situation(now: 12 * 60 + 30)), .offer(certain: true))
    }

    func testOnlyTheFirstDayOfALegHasAnArrival() {
        XCTAssertEqual(TripLateArrival.evaluate(situation(firstDay: false)), .quiet)
    }

    func testALegWithoutAnArrivalCannotBeLate() {
        XCTAssertEqual(TripLateArrival.evaluate(situation(arrive: nil)), .quiet)
    }

    func testATickedOffStopMeansTheyArrivedWhateverTheClockSays() {
        XCTAssertEqual(TripLateArrival.evaluate(situation(settled: 1)), .quiet)
    }

    func testItAsksOnce() {
        XCTAssertEqual(TripLateArrival.evaluate(situation(asked: true)), .quiet)
    }

    func testTheSentenceNamesBothTimes() {
        let certain = TripLateArrival.sentence(planned: 12 * 60, now: 17 * 60 + 5, certain: true)
        XCTAssertTrue(certain.contains("17:05"), certain)
        XCTAssertTrue(certain.contains("12:00"), certain)
        XCTAssertTrue(certain.hasPrefix("Angekommen"), certain)
        let open = TripLateArrival.sentence(planned: 12 * 60, now: 14 * 60, certain: false)
        XCTAssertTrue(open.contains("Seid ihr schon da?"), open)
    }
}

/// When a Live Activity's content stops being true (#768 §1).
final class TripDayActivityStaleDateTests: XCTestCase {

    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Berlin")!
        return calendar
    }

    private func date(_ hour: Int, _ minute: Int) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 9, day: 24, hour: hour, minute: minute))!
    }

    func testItIsTheEndOfTheBlock() {
        // Content built at 13:10 for a block ending 14:00 is stale at 14:00.
        let stale = TripDayActivityContent.staleDate(blockEndMinutes: 14 * 60, now: date(13, 10), calendar: calendar)
        XCTAssertEqual(stale, date(14, 0))
    }

    func testItIsNeverAlreadyPast() {
        // Built as the block ends: a minute of grace, not born stale.
        let now = date(14, 0)
        let stale = TripDayActivityContent.staleDate(blockEndMinutes: 14 * 60, now: now, calendar: calendar)
        XCTAssertEqual(stale, now.addingTimeInterval(60))
    }

    func testABlockWithoutAnEndHasNoStaleDate() {
        XCTAssertNil(TripDayActivityContent.staleDate(blockEndMinutes: nil, now: date(13, 10), calendar: calendar))
    }
}

/// The fence around the quarters (§4.2).
final class TripQuartersRegionTests: XCTestCase {

    func testAnAddressGetsAGenerousFence() {
        let region = TripGeofencePlan.anchorRegion(legId: 7, anchor: TripCoordinate(lat: 45.88, lon: 10.84), radiusM: nil)
        XCTAssertEqual(region.radius, TripGeofencePlan.anchorRadius)
        XCTAssertEqual(region.kind, .quarters)
        XCTAssertEqual(region.identifier, "anchor:7")
        // Not a visit: nothing planned to dwell for.
        XCTAssertEqual(region.plannedMinutes, 0)
    }

    func testAZoneKeepsItsOwnRadius() {
        let region = TripGeofencePlan.anchorRegion(legId: 7, anchor: TripCoordinate(lat: 45.88, lon: 10.84), radiusM: 2_000)
        XCTAssertEqual(region.radius, 2_000)
    }

    func testAStopsFenceIsAStop() {
        let region = TripMonitoredRegion(
            osmRef: "node:1", name: nil,
            center: .init(latitude: 45.88, longitude: 10.84), radius: 100, plannedMinutes: 30,
        )
        XCTAssertEqual(region.kind, .stop)
    }
}

/// What the day remembers it said (§7.1): a banner once, a card until
/// it is answered.
final class TripDayNoticePreferencesTests: XCTestCase {

    private var store: UserDefaults {
        let suite = "TripDayNoticePreferencesTests.\(UUID().uuidString)"
        return UserDefaults(suiteName: suite)!
    }

    func testNotifiedAndDismissedAreTwoDifferentQuestions() {
        let store = self.store
        let key = TripDayNoticePreferences.blockKey(planId: 1, dayIndex: 0, blockId: "afternoon", on: "2026-09-24")
        XCTAssertFalse(TripDayNoticePreferences.wasNotified(key, store: store))
        TripDayNoticePreferences.markNotified(key, store: store)
        XCTAssertTrue(TripDayNoticePreferences.wasNotified(key, store: store))
        // A banner having gone out does not mean the card was answered:
        // the app opened from that banner still has to show it.
        XCTAssertFalse(TripDayNoticePreferences.wasDismissed(key, store: store))
        TripDayNoticePreferences.markDismissed(key, store: store)
        XCTAssertTrue(TripDayNoticePreferences.wasDismissed(key, store: store))
    }

    func testKeysAreOnePerDayAndBlock() {
        // Tomorrow's afternoon is a different question from today's.
        XCTAssertNotEqual(
            TripDayNoticePreferences.blockKey(planId: 1, dayIndex: 0, blockId: "afternoon", on: "2026-09-24"),
            TripDayNoticePreferences.blockKey(planId: 1, dayIndex: 1, blockId: "afternoon", on: "2026-09-25"),
        )
        XCTAssertNotEqual(
            TripDayNoticePreferences.arrivalKey(planId: 1, dayIndex: 0, on: "2026-09-24"),
            TripDayNoticePreferences.quartersKey(planId: 1, dayIndex: 0, on: "2026-09-24"),
        )
    }
}

/// What a day that is over left behind (§5).
final class TripLeftoverTests: XCTestCase {

    private func stop(_ id: Int, status: String) -> TripStop {
        TripStop(
            rowId: id, osmRef: "node:\(id)", name: "Ort \(id)", lat: 45.88, lon: 10.84,
            category: "sight", dwellMinutes: 30,
            travelFromPrevious: TripTravel(minutes: 5, distanceM: 400, travelClass: "short_walk"),
            status: status, pinned: false, note: nil, sourceUrl: nil, title: nil, localName: nil,
            wikipediaUrl: nil, photoStop: nil,
        )
    }

    private func day(_ index: Int, detailed: Bool = true, stops: [TripStop]) -> TripDay {
        let block = TripBlock(
            id: "afternoon", rowId: index * 10, label: "Nachmittag", kind: "spots", budgetMinutes: 210,
            usedMinutes: 0, startMinutes: 14 * 60, stops: stops, branches: nil,
        )
        return TripDay(id: index, dayIndex: index, detailed: detailed, bufferReason: nil, blocks: [block], fixpoints: [])
    }

    private func leg(_ days: [TripDay]) -> TripLeg {
        TripLeg(
            id: 1, position: 0, title: "Beispielstadt", anchor: TripCoordinate(lat: 45.88, lon: 10.84),
            anchorRadiusM: nil, anchorLabel: nil, arriveMinutes: nil, mode: "foot", regionDb: "nom_x",
            awaitingRegion: nil, startDate: "2026-09-24", days: days, pool: [],
        )
    }

    func testTheDayBeforeTodayWithOpenStopsIsFound() throws {
        // The trial's case: day one strolled through without the plan,
        // every stop still "planned" on it the next morning.
        let found = try XCTUnwrap(TripLeftover.find(
            in: leg([day(0, stops: [stop(1, status: "planned"), stop(2, status: "done")]), day(1, stops: [])]),
            todayIndex: 1,
            dismissed: { _ in false },
        ))
        XCTAssertEqual(found.dayIndex, 0)
        XCTAssertEqual(found.stops.map(\.rowId), [1])
    }

    func testADayThatWasLivedLeavesNothing() {
        XCTAssertNil(TripLeftover.find(
            in: leg([day(0, stops: [stop(1, status: "done"), stop(2, status: "skipped")]), day(1, stops: [])]),
            todayIndex: 1,
            dismissed: { _ in false },
        ))
    }

    func testTodayAndTomorrowAreNotOver() {
        XCTAssertNil(TripLeftover.find(
            in: leg([day(0, stops: [stop(1, status: "planned")]), day(1, stops: [stop(2, status: "planned")])]),
            todayIndex: 0,
            dismissed: { _ in false },
        ))
    }

    func testAnAnsweredDayIsNotAskedAgain() {
        XCTAssertNil(TripLeftover.find(
            in: leg([day(0, stops: [stop(1, status: "planned")]), day(1, stops: [])]),
            todayIndex: 1,
            dismissed: { $0 == 0 },
        ))
    }

    func testTheMostRecentDayComesFirst() throws {
        let found = try XCTUnwrap(TripLeftover.find(
            in: leg([day(0, stops: [stop(1, status: "planned")]), day(1, stops: [stop(2, status: "planned")]), day(2, stops: [])]),
            todayIndex: 2,
            dismissed: { _ in false },
        ))
        XCTAssertEqual(found.dayIndex, 1)
    }

    func testADayAtTripResolutionHasNothingToLeave() {
        XCTAssertNil(TripLeftover.find(
            in: leg([day(0, detailed: false, stops: []), day(1, stops: [])]),
            todayIndex: 1,
            dismissed: { _ in false },
        ))
    }

    func testTheSentenceNamesAFewAndCounts() {
        let one = TripLeftover.sentence(dayNumber: 1, date: "24.09.", names: ["Kirche Beispiel"])
        XCTAssertTrue(one.contains("Von Tag 1 (24.09.) blieb 1 Spot liegen: Kirche Beispiel"), one)
        let many = TripLeftover.sentence(dayNumber: 2, date: nil, names: ["A", "B", "C", "D", "E"])
        XCTAssertTrue(many.contains("Von Tag 2 blieben 5 Spots liegen: A, B, C …"), many)
    }
}

/// The diary's open questions, as the app reads them (§6.4).
final class TripVisitSuggestionTests: XCTestCase {

    func testOnlyAnUnansweredStayAtAPlannedStopIsAQuestion() throws {
        let visits = try JSONDecoder().decode(TripVisitsResponse.self, from: Data("""
        { "visits": [
          { "id": 1, "stopId": 7, "osmRef": "node:7", "name": "Kirche Beispiel",
            "arrivedAt": "2026-09-24T10:00:00Z", "leftAt": "2026-09-24T10:20:00Z",
            "confirmed": false, "dismissed": false },
          { "id": 2, "stopId": 8, "osmRef": "node:8", "name": "Museum Beispiel",
            "arrivedAt": "2026-09-24T11:00:00Z", "leftAt": null,
            "confirmed": true, "dismissed": false },
          { "id": 3, "stopId": null, "osmRef": null, "name": null,
            "arrivedAt": "2026-09-24T12:00:00Z", "leftAt": null,
            "confirmed": false, "dismissed": false } ] }
        """.utf8)).visits
        XCTAssertEqual(visits.filter { $0.isOpen && $0.stopId != nil }.map(\.id), [1])
        XCTAssertEqual(visits[2].displayName, "diesem Ort")
    }

    func testTheReportAnswerCarriesTheVerdict() throws {
        let response = try JSONDecoder().decode(TripVisitReportResponse.self, from: Data("""
        { "verdict": "suggested", "visit": { "id": 1, "stopId": 7, "osmRef": "node:7",
          "name": "Kirche Beispiel", "arrivedAt": "2026-09-24T10:00:00Z", "leftAt": null,
          "confirmed": false, "dismissed": false } }
        """.utf8))
        XCTAssertEqual(response.verdict, "suggested")
        XCTAssertEqual(response.visit?.name, "Kirche Beispiel")
        let none = try JSONDecoder().decode(TripVisitReportResponse.self,
                                            from: Data(#"{ "verdict": "none", "visit": null }"#.utf8))
        XCTAssertNil(none.visit)
    }
}

/// The ballot's colours (§6.1): my answer, as a pin.
final class TripBallotPinKindTests: XCTestCase {

    private func entry(vote: String?, heart: Bool = false) -> TripBallotEntry {
        TripBallotEntry(
            osmRef: "node:1", name: "Kirche Beispiel", label: "Kirche Beispiel", category: "worship",
            myVote: vote, myHeart: heart, wants: [], ratherNots: [], hearts: [], planned: false,
        )
    }

    func testMyAnswerIsTheColour() {
        XCTAssertEqual(TripBallotPinKind.of(entry(vote: nil)), .open)
        XCTAssertEqual(TripBallotPinKind.of(entry(vote: "want")), .want)
        XCTAssertEqual(TripBallotPinKind.of(entry(vote: "meh")), .meh)
        XCTAssertEqual(TripBallotPinKind.of(entry(vote: "rather-not")), .ratherNot)
    }

    func testAHeartOutranksTheVoteItSitsOn() {
        // A heart is a "will ich" with a quota; the map shows the
        // rarer thing.
        XCTAssertEqual(TripBallotPinKind.of(entry(vote: "want", heart: true)), .heart)
    }

    func testAnAnswerTheAppDoesNotKnowIsStillOpen() {
        XCTAssertEqual(TripBallotPinKind.of(entry(vote: "maybe-later")), .open)
    }

    func testTheLegendStartsWithWhatIsLeftToDo() {
        XCTAssertEqual(TripBallotPinKind.legendOrder.first, .open)
        XCTAssertEqual(Set(TripBallotPinKind.legendOrder), Set(TripBallotPinKind.allCases))
    }
}
