import XCTest
@testable import FKPhotosLib

/// The day trip nobody asked for (§4.6), as the app reads it.
///
/// The answer is "nothing to say" far more often than not, and the
/// screen has to read that as a state of its own rather than as an
/// empty list — a leg whose own pool carries its days is not missing
/// anything.
@MainActor
final class TripDayTripTests: XCTestCase {

    private func answer(
        undersupplied: Bool = true,
        suggestion: String = Self.SUGGESTION,
        note: String? = nil,
    ) throws -> TripDayTripAnswer {
        func quoted(_ value: String?) -> String {
            guard let value else { return "null" }
            return "\"\(value)\""
        }
        return try JSONDecoder().decode(TripDayTripAnswer.self, from: Data("""
        { "legIndex": 0, "undersupplied": \(undersupplied),
          "emptyMinutes": 960, "poolMinutes": 120, "uncoveredMinutes": 840,
          "dayMinutes": 480, "suggestion": \(suggestion), "note": \(quoted(note)) }
        """.utf8))
    }

    private static let SUGGESTION = """
    { "dayIndex": 2,
      "target": { "name": "Beispielstadt", "source": "admin", "key": "area:900",
                  "osmRef": "area:900", "lat": 44.01, "lon": 11.04,
                  "distanceM": 60000, "travelMinutes": 60,
                  "dayAtTargetMinutes": 360, "spotCount": 40,
                  "examples": ["Dom zu Beispielstadt", "Stadtmuseum Beispiel"] },
      "sentence": "Vor Ort tragen die Vorschläge zwei eurer vier Tage." }
    """

    func testAnUndersuppliedLegArrivesWithItsOneDestination() throws {
        let decoded = try answer()
        XCTAssertTrue(decoded.undersupplied)
        XCTAssertEqual(decoded.suggestion?.target.name, "Beispielstadt")
        XCTAssertEqual(decoded.suggestion?.dayIndex, 2)
        XCTAssertEqual(decoded.suggestion?.target.spotCount, 40)
    }

    func testTheOrdinaryAnswerIsNothingToSay() throws {
        // The commonest case by a long way, and it is a state rather
        // than an empty list.
        let decoded = try answer(undersupplied: false, suggestion: "null",
                                 note: "Der Vorrat trägt die Tage.")
        XCTAssertNil(decoded.suggestion)
        XCTAssertFalse(decoded.undersupplied)
        XCTAssertEqual(decoded.note, "Der Vorrat trägt die Tage.")
    }

    func testTheCostSaysBothHalves() throws {
        // What it takes and what is left of the day: a drive stated
        // without the second half reads as free.
        let target = try XCTUnwrap(try answer().suggestion?.target)
        XCTAssertEqual(target.costSummary, "1 h hin · 6 h vor Ort")
    }

    func testTheKeyIsWhatAcceptingAndRefusingUse() throws {
        let target = try XCTUnwrap(try answer().suggestion?.target)
        XCTAssertEqual(target.key, "area:900")
        XCTAssertEqual(target.id, target.key)
    }

    func testALandscapeIsNotDrawnAsATown() throws {
        // A cluster of spots no municipality is: it has no reference,
        // and the key is where it is.
        let cluster = """
        { "dayIndex": 1,
          "target": { "name": "Beispieltal", "source": "cluster", "key": "at:44.010,11.040",
                      "osmRef": null, "lat": 44.01, "lon": 11.04,
                      "distanceM": 60000, "travelMinutes": 55,
                      "dayAtTargetMinutes": 370, "spotCount": 12, "examples": [] },
          "sentence": "…" }
        """
        let target = try XCTUnwrap(try answer(suggestion: cluster).suggestion?.target)
        XCTAssertNil(target.osmRef)
        XCTAssertEqual(target.symbolName, "mountain.2")
        XCTAssertTrue(target.key.hasPrefix("at:"))
    }

    func testATownIsDrawnAsOne() throws {
        let target = try XCTUnwrap(try answer().suggestion?.target)
        XCTAssertEqual(target.symbolName, "building.2")
    }

    func testTheArithmeticComesAlongSoItCanBeArguedWith() throws {
        // "Wir empfehlen" is not checkable; three numbers are (§10.7).
        let decoded = try answer()
        XCTAssertEqual(decoded.emptyMinutes, 960)
        XCTAssertEqual(decoded.poolMinutes, 120)
        XCTAssertEqual(decoded.uncoveredMinutes, 840)
        XCTAssertGreaterThanOrEqual(decoded.uncoveredMinutes, decoded.dayMinutes)
    }
}
