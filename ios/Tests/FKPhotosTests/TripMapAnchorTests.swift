import XCTest
@testable import FKPhotosLib

/// Which point the day's map is anchored to, and what the pin says
/// (§4.5).
///
/// The map drew a house labelled "Unterkunft" at the leg's anchor on
/// every day, including the days planned sixty kilometres away.
final class TripMapAnchorTests: XCTestCase {

    private let quarters = TripCoordinate(lat: 45.7648, lon: 10.8102)

    private func day(anchorLabel: String?, lat: Double, lon: Double) throws -> TripDay {
        try JSONDecoder().decode(TripDay.self, from: Data("""
        { "id": 1, "dayIndex": 0, "detailed": true, "bufferReason": null,
          "blocks": [], "fixpoints": [],
          "anchor": { "lat": \(lat), "lon": \(lon),
                      "label": \(anchorLabel.map { "\"\($0)\"" } ?? "null"),
                      "radiusM": null, "travelMinutes": 55,
                      "departMinutes": null, "returnMinutes": null,
                      "waterAround": null } }
        """.utf8))
    }

    private func plainDay() throws -> TripDay {
        try JSONDecoder().decode(TripDay.self, from: Data("""
        { "id": 2, "dayIndex": 1, "detailed": true, "bufferReason": null,
          "blocks": [], "fixpoints": [], "anchor": null }
        """.utf8))
    }

    func testAnOrdinaryDayIsAnchoredToTheQuarters() throws {
        let anchor = TripMapAnchor.of(day: try plainDay(), legAnchor: quarters)
        XCTAssertEqual(anchor.coordinate, quarters)
        XCTAssertEqual(anchor.label, "Unterkunft")
        XCTAssertEqual(anchor.symbolName, "house.fill")
    }

    func testADayWithoutAPlanAtAllIsStillTheQuarters() throws {
        let anchor = TripMapAnchor.of(day: nil, legAnchor: quarters)
        XCTAssertEqual(anchor.coordinate, quarters)
    }

    func testADayTripIsAnchoredToItsDestination() throws {
        // The pins of this day sit around the outing; a house an hour's
        // drive away is not where the day starts or ends.
        let anchor = TripMapAnchor.of(
            day: try day(anchorLabel: "Verona", lat: 45.4384, lon: 10.9916),
            legAnchor: quarters,
        )
        XCTAssertEqual(anchor.coordinate, TripCoordinate(lat: 45.4384, lon: 10.9916))
        XCTAssertEqual(anchor.label, "Verona")
        // And it is not a house: the group sleeps elsewhere.
        XCTAssertNotEqual(anchor.symbolName, "house.fill")
    }

    func testAnOutingNobodyNamedSaysWhatItIsRatherThanBorrowingTheHotelsWord() throws {
        // "Auswärts" reads as a label on a list row; on a map pin it
        // says nothing. Neither may become "Unterkunft" (§15.3).
        let anchor = TripMapAnchor.of(
            day: try day(anchorLabel: nil, lat: 45.4384, lon: 10.9916),
            legAnchor: quarters,
        )
        XCTAssertEqual(anchor.label, "Ausflugsziel")
    }
}
