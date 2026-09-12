import XCTest
@testable import FKPhotosLib

/// A day that happens somewhere the trip does not sleep (§4.5).
///
/// The app's whole share of this is one sentence — and the sentence has
/// to carry the half that explains why the day is shorter, or the
/// traveller reads a shrunken afternoon as a planner that gave up.
final class TripDayAnchorTests: XCTestCase {

    private func anchor(
        label: String?,
        travelMinutes: Int,
        departMinutes: Int? = nil,
        returnMinutes: Int? = nil,
    ) throws -> TripDayAnchor {
        try JSONDecoder().decode(TripDayAnchor.self, from: Data("""
        { "lat": 43.7199, "lon": 10.3973,
          "label": \(label.map { "\"\($0)\"" } ?? "null"),
          "radiusM": null, "travelMinutes": \(travelMinutes),
          "departMinutes": \(departMinutes.map(String.init) ?? "null"),
          "returnMinutes": \(returnMinutes.map(String.init) ?? "null") }
        """.utf8))
    }

    func testItNamesThePlaceAndBothDrives() throws {
        // Both ways, because both come out of this day: an hour there
        // and an hour back is two hours the day does not have.
        XCTAssertEqual(try anchor(label: "Pisa", travelMinutes: 70).summary,
                       "Pisa · 2 h 20 hin und zurück")
    }

    func testAPlaceNobodyNamedStillSaysItIsElsewhere() throws {
        // Never invented (§15.3) — "Auswärts" is true, a guessed city
        // name would not be.
        XCTAssertEqual(try anchor(label: nil, travelMinutes: 30).summary,
                       "Auswärts · 1 h hin und zurück")
        XCTAssertEqual(try anchor(label: "   ", travelMinutes: 30).displayName, "Auswärts")
    }

    func testWithoutADriveItIsJustTheName() throws {
        // The server treats an anchor at the quarters as no day trip at
        // all; if one ever arrives, the sentence does not claim a zero.
        XCTAssertEqual(try anchor(label: "Pisa", travelMinutes: 0).summary, "Pisa")
    }

    func testADayFromAnOlderServerHasNoDestination() throws {
        // The field is optional so a response written before §4.5 still
        // decodes — as an ordinary day, which is what it was.
        let day = try JSONDecoder().decode(TripDay.self, from: Data("""
        { "id": 1, "dayIndex": 0, "detailed": true, "blocks": [], "fixpoints": [] }
        """.utf8))
        XCTAssertNil(day.anchor)
    }

    func testTheDestinationDecodesWithTheDay() throws {
        let day = try JSONDecoder().decode(TripDay.self, from: Data("""
        { "id": 1, "dayIndex": 1, "detailed": true, "blocks": [], "fixpoints": [],
          "anchor": { "lat": 43.7199, "lon": 10.3973, "label": "Pisa",
                      "radiusM": 6000, "travelMinutes": 70 } }
        """.utf8))
        XCTAssertEqual(day.anchor?.displayName, "Pisa")
        XCTAssertEqual(day.anchor?.radiusM, 6_000)
        XCTAssertEqual(day.anchor?.coordinate.lat, 43.7199)
    }

    func testNamedHoursReplaceTheEstimateInTheSentence() throws {
        // The estimate is arithmetic on a straight line (§12). Somebody
        // who typed the hours knows the drive better than it does, and
        // the day card should say what they know, not what it guessed.
        let outing = try anchor(label: "Pisa", travelMinutes: 82,
                                departMinutes: 8 * 60, returnMinutes: 17 * 60)
        XCTAssertEqual(outing.summary, "Pisa · 08:00–17:00")
    }

    func testOneHourOnItsOwnStillReads() throws {
        // "We leave at eight" says nothing about coming back, and
        // holding out for the other half would ask for a plan the
        // traveller has not made.
        XCTAssertEqual(try anchor(label: "Pisa", travelMinutes: 82, departMinutes: 8 * 60).summary,
                       "Pisa · ab 08:00")
        XCTAssertEqual(try anchor(label: "Pisa", travelMinutes: 82, returnMinutes: 17 * 60).summary,
                       "Pisa · zurück 17:00")
    }

    func testWithoutHoursTheEstimateStillExplainsTheShorterDay() throws {
        let outing = try anchor(label: "Pisa", travelMinutes: 82)
        XCTAssertNil(outing.plannedHours)
        XCTAssertEqual(outing.summary, "Pisa · 2 h 44 hin und zurück")
    }

    func testTheArrivalIsTheDeparturePlusTheDrive() throws {
        let outing = try anchor(label: "Pisa", travelMinutes: 82, departMinutes: 8 * 60)
        XCTAssertEqual(outing.arrivalMinutes, 8 * 60 + 82)
        XCTAssertNil(try anchor(label: "Pisa", travelMinutes: 82).arrivalMinutes)
    }

    func testADayFromAnOlderServerHasNoHours() throws {
        // The two fields are optional, so a response written before the
        // hours existed still decodes — as an outing nobody timed.
        let older = try JSONDecoder().decode(TripDayAnchor.self, from: Data("""
        { "lat": 43.7199, "lon": 10.3973, "label": "Pisa",
          "radiusM": null, "travelMinutes": 82 }
        """.utf8))
        XCTAssertNil(older.departMinutes)
        XCTAssertNil(older.returnMinutes)
        XCTAssertEqual(older.summary, "Pisa · 2 h 44 hin und zurück")
    }
}
