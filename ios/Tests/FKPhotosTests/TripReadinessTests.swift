import XCTest
@testable import FKPhotosLib

/// The evening before, as the screen reads it (§8.6).
///
/// Two things matter here and nothing else does: that the check the
/// server cannot make is answered from the device, and that a question
/// the app *cannot* answer never looks like a warning — an amber row
/// somebody can do nothing about teaches people to ignore amber rows.
final class TripReadinessTests: XCTestCase {

    private let json = """
    {
      "startsOn": "2026-06-18",
      "forecastUntil": "2026-06-20",
      "checks": [
        { "id": "dates", "state": "ok", "sentence": "Es geht am 2026-06-18 los." },
        { "id": "region", "state": "attention",
          "sentence": "Die Karten fehlen noch: Beispielstadt." },
        { "id": "tickets", "state": "unknown",
          "sentence": "Tickets kann die App noch nicht prüfen." }
      ],
      "packing": [
        { "id": "rain-jacket", "label": "Regenjacke",
          "reason": "Am 2026-06-18 ist der Nachmittag draußen und nass" }
      ]
    }
    """

    func testTheAnswerDecodes() throws {
        let readiness = try JSONDecoder().decode(TripReadiness.self, from: Data(json.utf8))

        XCTAssertEqual(readiness.startsOn, "2026-06-18")
        XCTAssertEqual(readiness.checks.count, 3)
        XCTAssertEqual(readiness.packing.first?.label, "Regenjacke")
        // The reason travels with the item — a packing list without one
        // is the generic list §8.6 refuses to be.
        XCTAssertTrue(readiness.packing.first?.reason.contains("2026-06-18") == true)
    }

    func testAQuestionTheAppCannotAnswerIsNotAWarning() throws {
        let readiness = try JSONDecoder().decode(TripReadiness.self, from: Data(json.utf8))
        let tickets = readiness.checks.first { $0.id == "tickets" }

        XCTAssertEqual(tickets?.symbolName, "questionmark.circle")
        XCTAssertNotEqual(tickets?.tint, .orange)
    }

    func testWhatToDoTonightIsAmberAndWhatIsDoneIsGreen() throws {
        let readiness = try JSONDecoder().decode(TripReadiness.self, from: Data(json.utf8))

        XCTAssertEqual(readiness.checks.first { $0.id == "region" }?.tint, .orange)
        XCTAssertEqual(readiness.checks.first { $0.id == "dates" }?.tint, .green)
    }

    func testThePlanOnTheDeviceIsAnswerFromTheDevice() {
        let stored = TripReadinessCheck.offline(storedAt: Date())
        XCTAssertEqual(stored.state, "ok")
        XCTAssertTrue(stored.sentence.contains("Stand von"))

        let missing = TripReadinessCheck.offline(storedAt: nil)
        XCTAssertEqual(missing.state, "attention")
        XCTAssertTrue(missing.sentence.contains("Ohne Netz"))
    }
}
