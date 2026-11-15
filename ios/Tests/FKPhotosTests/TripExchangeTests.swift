import XCTest
import UniformTypeIdentifiers
@testable import FKPhotosLib

/// A trip or the idea collection as a ZIP file (`TripExchange`).
final class TripExchangeTests: XCTestCase {
    func testTheExportAsksForTheNameInThePhonesOwnTime() throws {
        let zone = try XCTUnwrap(TimeZone(identifier: "America/Los_Angeles"))
        let body = try JSONEncoder().encode(TripExchange.exportRequest(.trip, planId: 7, timeZone: zone))
        let decoded = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        XCTAssertEqual(decoded?["what"] as? String, "trip")
        XCTAssertEqual(decoded?["planId"] as? Int, 7)
        XCTAssertEqual(decoded?["timeZone"] as? String, "America/Los_Angeles")
    }

    func testTheFileGoesInByteForByte() throws {
        let file = Data([0x50, 0x4b, 0x03, 0x04, 0xff])
        let body = try JSONEncoder().encode(TripExchange.ImportRequest(file: file.base64EncodedString(), expect: .ideas))
        let decoded = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        XCTAssertEqual((decoded?["file"] as? String).flatMap { Data(base64Encoded: $0) }, file)
        XCTAssertEqual(decoded?["expect"] as? String, "ideas")
    }

    func testTheImportAnswerOfOneTripHasNoIdeas() throws {
        let json = Data(#"{"kind":"trip","trips":[{"planId":3,"title":"Beispielreise"}],"ideas":null}"#.utf8)
        let answer = try JSONDecoder().decode(TripExchange.ImportResponse.self, from: json)
        XCTAssertEqual(answer.kind, .trip)
        XCTAssertEqual(answer.trips.first?.planId, 3)
        XCTAssertNil(answer.ideas)
    }

    func testThePickerTakesTheZipAndAnOlderJsonFile() {
        XCTAssertEqual(TripExchange.importTypes, [.zip, .json])
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
