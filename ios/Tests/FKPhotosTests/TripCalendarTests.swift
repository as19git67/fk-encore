import XCTest
@testable import FKPhotosLib

/// When a trip runs, and which day of it today is (§8.1, §8.5).
///
/// This is the whole of "einen geplanten Trip starten": there is no
/// button, there are dates. Which puts all the weight on arithmetic
/// that is famously easy to get a day wrong in — a date is a *day*, not
/// an instant, and half the world is on the other side of UTC midnight.
final class TripCalendarTests: XCTestCase {

    /// A timezone well east of UTC, where an instant-based
    /// implementation reports yesterday for most of the morning.
    private let tokyo = TimeZone(identifier: "Asia/Tokyo")!
    /// And one well west, where it reports tomorrow all evening.
    private let losAngeles = TimeZone(identifier: "America/Los_Angeles")!

    private func at(_ iso: String) -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: iso)!
    }

    func testAnIsoDayIsTheDayWhereTheTravellerIs() {
        // 23:30 UTC on the 16th is already the 17th in Tokyo and still
        // the 16th in Los Angeles. Both are right; the point is that
        // the traveller's own calendar decides.
        let instant = at("2026-09-16T23:30:00Z")
        XCTAssertEqual(TripCalendar.isoDay(instant, timeZone: tokyo), "2026-09-17")
        XCTAssertEqual(TripCalendar.isoDay(instant, timeZone: losAngeles), "2026-09-16")
    }

    func testDaysBetweenCountsWholeDaysAcrossAClockChange() {
        // The last Sunday in October is 23 hours long in Europe.
        let berlin = TimeZone(identifier: "Europe/Berlin")!
        XCTAssertEqual(TripCalendar.days(from: "2026-10-24", to: "2026-10-27", timeZone: berlin), 3)
        XCTAssertEqual(TripCalendar.day("2026-10-24", plus: 3, timeZone: berlin), "2026-10-27")
    }

    func testDaysBetweenIsNegativeGoingBackwards() {
        XCTAssertEqual(TripCalendar.days(from: "2026-09-17", to: "2026-09-15"), -2)
    }

    func testARoundTripThroughADateKeepsTheDay() {
        // A leap day, which is the one a formatter is most likely to
        // move. 2028, because 2026 has no 29th of February — and a
        // formatter asked for one answers with the 1st of March.
        let day = "2028-02-29"
        let date = TripCalendar.date(fromIsoDay: day, timeZone: tokyo)
        XCTAssertNotNil(date)
        XCTAssertEqual(TripCalendar.isoDay(date!, timeZone: tokyo), day)
    }

    // MARK: - The schedule

    private func schedule(_ start: String?, days: Int, today: String) -> TripSchedule {
        TripScheduling.schedule(
            startDate: start, dayCount: days,
            today: TripCalendar.date(fromIsoDay: today)!)
    }

    func testATripWithNoDatesIsUndated() {
        XCTAssertEqual(schedule(nil, days: 3, today: "2026-09-17"), .undated)
    }

    func testTheFirstDayCountsAsRunning() {
        XCTAssertEqual(schedule("2026-09-17", days: 3, today: "2026-09-17"),
                       .running(dayNumber: 1, dayCount: 3))
    }

    func testTheLastDayStillCountsAsRunning() {
        // Off-by-one country: a three-day trip from the 17th runs
        // through the 19th, not the 20th, and ends *after* the 19th.
        XCTAssertEqual(schedule("2026-09-17", days: 3, today: "2026-09-19"),
                       .running(dayNumber: 3, dayCount: 3))
        XCTAssertEqual(schedule("2026-09-17", days: 3, today: "2026-09-20"), .past(days: 1))
    }

    func testATripAheadCountsDown() {
        XCTAssertEqual(schedule("2026-09-17", days: 3, today: "2026-09-16"), .upcoming(days: 1))
        XCTAssertEqual(schedule("2026-09-17", days: 3, today: "2026-09-10"), .upcoming(days: 7))
    }

    func testTheLabelSaysSomethingUseful() {
        XCTAssertEqual(TripSchedule.upcoming(days: 1).label, "Morgen geht’s los")
        XCTAssertEqual(TripSchedule.running(dayNumber: 2, dayCount: 5).label,
                       "Läuft — Tag 2 von 5")
        XCTAssertEqual(TripSchedule.past(days: 1).label, "Gestern zu Ende")
        XCTAssertTrue(TripSchedule.running(dayNumber: 1, dayCount: 1).isRunning)
        XCTAssertFalse(TripSchedule.upcoming(days: 1).isRunning)
    }

    // MARK: - Which day of which leg

    /// Two legs, dated back to back: three days, then two.
    private func twoLegPlan(firstStart: String?, secondStart: String?) -> TripPlan {
        func day(_ index: Int) -> TripDay {
            TripDay(id: 100 + index, dayIndex: index, detailed: true, blocks: [], fixpoints: [])
        }
        func leg(_ position: Int, _ start: String?, _ days: Int) -> TripLeg {
            TripLeg(id: 10 + position, position: position, title: "Etappe \(position)",
                    anchor: TripCoordinate(lat: 48.1, lon: 11.5), anchorRadiusM: nil,
                    mode: "foot", regionDb: "nom_test", startDate: start,
                    days: (0..<days).map(day), pool: [])
        }
        return TripPlan(id: 1, ownerId: 1, title: "Zwei Städte", constraints: nil,
                        legs: [leg(0, firstStart, 3), leg(1, secondStart, 2)])
    }

    func testFindsTheDayOfTheFirstLeg() {
        let plan = twoLegPlan(firstStart: "2026-09-17", secondStart: "2026-09-20")
        XCTAssertEqual(plan.position(on: TripCalendar.date(fromIsoDay: "2026-09-18")!),
                       TripDayPosition(legIndex: 0, dayIndex: 1))
    }

    func testFindsTheDayOfTheSecondLeg() {
        let plan = twoLegPlan(firstStart: "2026-09-17", secondStart: "2026-09-20")
        XCTAssertEqual(plan.position(on: TripCalendar.date(fromIsoDay: "2026-09-21")!),
                       TripDayPosition(legIndex: 1, dayIndex: 1))
    }

    func testADayInNoLegIsNoPosition() {
        // The gap between the legs — a travel day nobody planned — is
        // not a day of either, and guessing one would open a screen
        // showing the wrong city.
        let plan = twoLegPlan(firstStart: "2026-09-17", secondStart: "2026-09-22")
        XCTAssertNil(plan.position(on: TripCalendar.date(fromIsoDay: "2026-09-21")!))
    }

    func testAnUndatedTripHasNoDayOfItsOwn() {
        let plan = twoLegPlan(firstStart: nil, secondStart: nil)
        XCTAssertNil(plan.position(on: Date()))
    }

    func testAPartlyDatedTripStillFindsTheLegThatHasDates() {
        let plan = twoLegPlan(firstStart: nil, secondStart: "2026-09-20")
        XCTAssertEqual(plan.position(on: TripCalendar.date(fromIsoDay: "2026-09-20")!),
                       TripDayPosition(legIndex: 1, dayIndex: 0))
    }

    func testTheTripsStartDateIsTheEarliestLegThatHasOne() {
        XCTAssertEqual(twoLegPlan(firstStart: nil, secondStart: "2026-09-20").startDate,
                       "2026-09-20")
        XCTAssertEqual(twoLegPlan(firstStart: "2026-09-17", secondStart: "2026-09-20").startDate,
                       "2026-09-17")
    }
}
