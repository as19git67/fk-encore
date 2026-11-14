import XCTest
@testable import FKPhotosLib

/// A trip or the idea collection as a file (`TripExchange`).
final class TripExchangeTests: XCTestCase {
    func testTheFileGoesInByteForByte() throws {
        let file = Data(#"{"format":"f4mil.ideas","version":1,"ideas":[]}"#.utf8)
        let body = TripExchange.wrapped(file)
        let decoded = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        let inner = decoded?["data"] as? [String: Any]
        XCTAssertEqual(inner?["format"] as? String, "f4mil.ideas")
        XCTAssertEqual(inner?["version"] as? Int, 1)
    }

    func testAFileNameSurvivesEveryDisk() {
        XCTAssertEqual(TripExchange.fileName("Beispiel/Reise: Teil 2", suffix: "reise.json"),
                       "Beispiel-Reise- Teil 2.reise.json")
        XCTAssertEqual(TripExchange.fileName("  ", suffix: "reise.json"), "Reise.reise.json")
    }

    func testTheOutcomeSaysWhatWasLeftAlone() {
        XCTAssertEqual(TripExchange.ideasOutcome(.init(added: 3, skipped: 0)), "3 Ideen übernommen.")
        XCTAssertEqual(TripExchange.ideasOutcome(.init(added: 1, skipped: 2)),
                       "1 Idee übernommen, 2 waren schon vorhanden.")
        XCTAssertEqual(TripExchange.ideasOutcome(.init(added: 0, skipped: 1)),
                       "0 Ideen übernommen, 1 war schon vorhanden.")
    }

    func testTheWholeImportSaysTripsAndIdeas() {
        let result = TripExchange.ImportedPlanner(
            trips: [.init(planId: 1, title: "Beispielreise"), .init(planId: 2, title: nil)],
            ideas: .init(added: 1, skipped: 1))
        XCTAssertEqual(TripExchange.plannerOutcome(result),
                       "2 Reisen angelegt. 1 Idee übernommen, 1 war schon vorhanden.")
    }
}
