import XCTest
@testable import FKPhotosLib

/// Somebody entered by hand (§3.5): the one thing that can go wrong
/// silently is the date.
final class TripManualTravellerTests: XCTestCase {

    func testABirthDateIsADateNotAnInstant() {
        // Local midnight on the 2nd, east of Greenwich: as an instant
        // this is still the 1st in UTC, and the server would age the
        // person a day. The local calendar says the 2nd.
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Berlin")!
        let date = calendar.date(from: DateComponents(year: 1944, month: 2, day: 2))!

        XCTAssertEqual(TripManualTraveller.isoDate(date, calendar: calendar), "1944-02-02")
    }

    func testWithoutADateNothingIsSent() {
        let entry = TripManualTraveller(name: "Oma", birthDate: nil, shortWalks: true)
        XCTAssertNil(entry.birthDateString)
        XCTAssertTrue(entry.isValid)
    }

    func testANameIsTrimmedAndWhitespaceIsNotAName() {
        XCTAssertEqual(
            TripManualTraveller(name: "  Oma ", birthDate: nil, shortWalks: false).trimmedName,
            "Oma")
        XCTAssertFalse(TripManualTraveller(name: "   ", birthDate: nil, shortWalks: false).isValid)
    }
}
