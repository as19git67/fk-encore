import XCTest
@testable import FKPhotosLib

/// "Als Abendtermin einplanen?" as the screen reads it (§7.3).
///
/// The window is computed to the minute while the plan stays coarse,
/// and what keeps that from reading as an appointment is the wording —
/// plus the fact that nothing is written until somebody taps.
final class TripEveningLightTests: XCTestCase {

    private let json = """
    { "date": "2027-07-01",
      "proposals": [
        { "osmRef": "way:7", "label": "Aussichtsterrasse",
          "from": "2027-07-01T18:30:00.000Z", "to": "2027-07-01T19:42:00.000Z",
          "fromMinutes": 1230, "toMinutes": 1302, "kind": "golden",
          "sentence": "Aussichtsterrasse liegt heute von ca. 20:30 bis 21:42 im besten Licht. Als Abendtermin einplanen?",
          "lat": 48.14, "lon": 11.58 }
      ] }
    """

    private func answer() throws -> TripEveningLight {
        try JSONDecoder().decode(TripEveningLight.self, from: Data(json.utf8))
    }

    func testTheProposalKeepsItsHedgeAndItsQuestion() throws {
        // "ca." and a question mark: a hint, not a time in the plan.
        let proposal = try answer().proposals[0]

        XCTAssertTrue(proposal.sentence.contains("ca."))
        XCTAssertTrue(proposal.sentence.hasSuffix("Als Abendtermin einplanen?"))
    }

    func testTheFixpointWouldStartWhenTheLightDoes() throws {
        let proposal = try answer().proposals[0]

        XCTAssertEqual(proposal.clockFrom, "20:30")
        XCTAssertEqual(proposal.toMinutes - proposal.fromMinutes, 72)
    }

    func testGoldenAndBlueLookDifferent() throws {
        let golden = try answer().proposals[0]
        XCTAssertEqual(golden.symbolName, "sun.horizon")

        let json = """
        { "date": "2027-07-01", "proposals": [
            { "osmRef": "way:8", "label": "Brücke", "from": "x", "to": "y",
              "fromMinutes": 1303, "toMinutes": 1318, "kind": "blue",
              "sentence": "…", "lat": 48.1, "lon": 11.5 } ] }
        """
        let blue = try JSONDecoder()
            .decode(TripEveningLight.self, from: Data(json.utf8)).proposals[0]
        XCTAssertEqual(blue.symbolName, "moon.stars")
    }

    func testATripWithoutDatesHasNoEveningToSpeakOf() throws {
        let json = #"{ "date": null, "proposals": [] }"#
        let answer = try JSONDecoder().decode(TripEveningLight.self, from: Data(json.utf8))

        XCTAssertNil(answer.date)
        XCTAssertTrue(answer.proposals.isEmpty)
    }
}
