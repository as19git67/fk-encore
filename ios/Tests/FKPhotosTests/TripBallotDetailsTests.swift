import XCTest
@testable import FKPhotosLib

/// What a ballot row may say about the place it asks about (§6.1, §3.8).
///
/// Voting on a name is voting on a word. The answers — what it is, and
/// whether it is round the corner or across the city — were in the plan
/// all along, one screen away and unasked.
final class TripBallotDetailsTests: XCTestCase {

    private let anchor = TripCoordinate(lat: 43.4677, lon: 11.0430)

    /// A leg out of JSON, because that is how one really arrives.
    private func leg(days: String = "[]", pool: String = "[]") throws -> TripLeg {
        try JSONDecoder().decode(TripLeg.self, from: Data("""
        { "id": 1, "position": 0, "title": "Basis",
          "anchor": { "lat": \(anchor.lat), "lon": \(anchor.lon) },
          "anchorRadiusM": null, "anchorLabel": null, "arriveMinutes": null,
          "mode": "car", "regionDb": "nom_x", "awaitingRegion": false, "startDate": null,
          "days": \(days), "pool": \(pool) }
        """.utf8))
    }

    private func plannedDay(_ index: Int, block: String, ref: String,
                            category: String = "museum", dwell: Int = 90,
                            note: String = "null") -> String {
        """
        { "id": \(index + 1), "dayIndex": \(index), "detailed": true, "fixpoints": [],
          "blocks": [ { "id": "b", "rowId": 1, "label": "\(block)", "kind": "spots",
            "budgetMinutes": 180, "usedMinutes": 90, "startMinutes": 540, "stops": [
              { "rowId": 7, "osmRef": "\(ref)", "name": "Palazzo",
                "lat": 43.47, "lon": 11.05, "category": "\(category)",
                "dwellMinutes": \(dwell),
                "travelFromPrevious": { "minutes": 0, "distanceM": 0,
                                        "travelClass": "short_walk" },
                "status": "planned", "pinned": false, "note": \(note),
                "sourceUrl": null, "title": null, "localName": null,
                "wikipediaUrl": null, "photoStop": null } ] } ] }
        """
    }

    private func pooled(_ ref: String, at: TripCoordinate, category: String = "viewpoint",
                        dwell: Int = 20, note: String = "null") -> String {
        """
        { "osmRef": "\(ref)", "name": "Aussicht", "lat": \(at.lat), "lon": \(at.lon),
          "category": "\(category)", "dwellMinutes": \(dwell), "score": 2, "reasons": [],
          "origin": "search", "note": \(note), "sourceUrl": null, "unmatched": false }
        """
    }

    func testAPlannedSpotSaysWhichDayAndBlock() throws {
        // "Where" in a trip is a day and a block, not a coordinate.
        let leg = try leg(days: "[\(plannedDay(1, block: "Vormittag", ref: "node:1"))]")
        let details = TripBallotDetails.of("node:1", in: leg)
        XCTAssertEqual(details.line, "Museum · 1 h 30 · Tag 2, Vormittag")
        XCTAssertEqual(details.spot?.osmRef, "node:1")
    }

    func testAPooledSpotSaysHowFarAndWhichWay() throws {
        // Roughly four kilometres due north of the quarters.
        let north = TripCoordinate(lat: anchor.lat + 0.036, lon: anchor.lon)
        let leg = try leg(pool: "[\(pooled("node:9", at: north))]")
        let details = TripBallotDetails.of("node:9", in: leg)
        XCTAssertTrue(details.line.hasPrefix("Aussichtspunkt · 20 min · "), details.line)
        XCTAssertTrue(details.line.hasSuffix("km nördlich"), details.line)
    }

    func testTheNoteTravelsWithTheRow() throws {
        // What somebody wrote next to it decides an afternoon (§9.2) —
        // without it the row asks about a word.
        let leg = try leg(pool: "[\(pooled("node:9", at: anchor, note: "\" Papa wollte da hin \""))]")
        XCTAssertEqual(TripBallotDetails.of("node:9", in: leg).note, "Papa wollte da hin")
    }

    func testAnEmptyNoteIsNoNote() throws {
        let leg = try leg(pool: "[\(pooled("node:9", at: anchor, note: "\"   \""))]")
        XCTAssertNil(TripBallotDetails.of("node:9", in: leg).note)
    }

    func testSomethingTheLegNoLongerHasSaysNothing() throws {
        // Dropped between two loads. An empty line beats a confident
        // one about a spot nobody can find.
        let details = TripBallotDetails.of("node:404", in: try leg())
        XCTAssertEqual(details.line, "")
        XCTAssertNil(details.spot)
    }

    func testRightAtTheQuartersSaysSo() {
        // A bearing for fifty metres is a precision nobody standing on
        // a street can use.
        let almost = TripCoordinate(lat: anchor.lat + 0.0004, lon: anchor.lon)
        XCTAssertEqual(TripBallotDetails.whereFrom(anchor, to: almost), "an der Unterkunft")
    }

    func testTheCompassRoundsToEight() {
        let north = TripCoordinate(lat: anchor.lat + 0.05, lon: anchor.lon)
        let east = TripCoordinate(lat: anchor.lat, lon: anchor.lon + 0.05)
        let southWest = TripCoordinate(lat: anchor.lat - 0.05, lon: anchor.lon - 0.07)
        XCTAssertEqual(TripBallotDetails.compass(from: anchor, to: north), "nördlich")
        XCTAssertEqual(TripBallotDetails.compass(from: anchor, to: east), "östlich")
        XCTAssertEqual(TripBallotDetails.compass(from: anchor, to: southWest), "südwestlich")
    }

    func testAPlannedSpotBeatsAPoolEntryOfTheSameRef() throws {
        // Both can name the same spot for a moment after a re-plan. The
        // day is the more useful answer, and the more current one.
        let leg = try leg(days: "[\(plannedDay(0, block: "Nachmittag", ref: "node:1"))]",
                          pool: "[\(pooled("node:1", at: anchor))]")
        XCTAssertTrue(TripBallotDetails.of("node:1", in: leg).line.contains("Tag 1, Nachmittag"))
    }
}
