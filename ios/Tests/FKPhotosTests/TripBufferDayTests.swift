import XCTest
@testable import FKPhotosLib

/// The buffer day a climate normal asks for (§7.2).
///
/// An empty day looks exactly like a day the planner failed to fill,
/// and only one of the two is worth keeping — so the model carries the
/// sentence, not a flag, and the screen says which kind of empty it is.
final class TripBufferDayTests: XCTestCase {

    private func day(_ json: String) throws -> TripDay {
        try JSONDecoder().decode(TripDay.self, from: Data(json.utf8))
    }

    func testADayKeptFreeSaysWhy() throws {
        let day = try day("""
        { "id": 3, "dayIndex": 2, "detailed": false,
          "bufferReason": "Im September ist dort etwa jeder 3. Tag nass (12 Regentage, 210 mm).",
          "blocks": [], "fixpoints": [] }
        """)

        XCTAssertTrue(day.isBuffer)
        XCTAssertTrue(day.bufferReason?.contains("Regentage") == true)
    }

    func testAnUnplannedDayIsNotABufferDay() throws {
        // Both are empty; only one is empty on purpose.
        let day = try day("""
        { "id": 4, "dayIndex": 9, "detailed": false, "blocks": [], "fixpoints": [] }
        """)

        XCTAssertFalse(day.isBuffer)
        XCTAssertNil(day.bufferReason)
    }

    func testAnEmptyReasonIsNoReason() throws {
        let day = try day("""
        { "id": 5, "dayIndex": 1, "detailed": false, "bufferReason": "",
          "blocks": [], "fixpoints": [] }
        """)

        XCTAssertFalse(day.isBuffer)
    }

    func testTheClimateReportSaysWhatIsMissingRatherThanThatSomethingIs() throws {
        let json = """
        { "legs": [ { "legIndex": 0, "legTitle": "München", "month": 9,
            "reasons": ["Im September ist dort etwa jeder 3. Tag nass."],
            "bufferDayIndex": 2, "indoorShare": 0.1, "wantedIndoorShare": 0.3,
            "shortfall": 5,
            "sentence": "… Im Vorrat fehlen dafür etwa 5 Spots, die auch bei Regen gehen." } ] }
        """
        let report = try JSONDecoder()
            .decode(TripClimateCheck.self, from: Data(json.utf8))

        XCTAssertEqual(report.legs[0].shortfall, 5)
        XCTAssertEqual(report.legs[0].bufferDayIndex, 2)
        XCTAssertTrue(report.legs[0].sentence?.contains("5 Spots") == true)
    }

    func testALegWithNothingToPrepareForSaysNothing() throws {
        // A screen that reports "alles in Ordnung" about every leg
        // trains people to skip it (§8.6).
        let json = """
        { "legs": [ { "legIndex": 0, "legTitle": "München", "month": null,
            "reasons": [], "bufferDayIndex": null, "indoorShare": 0.4,
            "wantedIndoorShare": null, "shortfall": 0, "sentence": null } ] }
        """
        let report = try JSONDecoder()
            .decode(TripClimateCheck.self, from: Data(json.utf8))

        XCTAssertNil(report.legs[0].sentence)
        XCTAssertTrue(report.legs[0].reasons.isEmpty)
    }
}
