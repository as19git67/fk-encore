import XCTest
@testable import FKPhotosLib

/// What a browsed spot says about itself (§9.2, case 4 widened).
///
/// The list is the whole screen, so the line under each name carries
/// everything somebody decides on: how far, how long, and whether it is
/// open. Small enough to get wrong quietly, which is what these are for.
final class TripExploreTests: XCTestCase {

    private func spot(
        name: String? = "Museo Civico",
        localName: String? = nil,
        distanceM: Int = 400,
        dwellMinutes: Int = 90,
        openingHours: String? = nil,
        collected: Bool = false,
    ) -> TripExploredSpot {
        TripExploredSpot(
            osmRef: "node:1",
            name: name,
            localName: localName,
            lat: 43.47,
            lon: 11.04,
            distanceM: distanceM,
            category: "museum",
            dwellMinutes: dwellMinutes,
            openingHours: openingHours,
            website: nil,
            wikipediaUrl: nil,
            reasons: ["hat einen Wikipedia-Artikel"],
            collected: collected,
        )
    }

    func testTheFactsLineSaysHowFarAndHowLong() {
        XCTAssertEqual(spot().factsLine, "400 m · 1 h 30")
    }

    func testKilometresReadAsKilometres() {
        XCTAssertEqual(spot(distanceM: 2_400, dwellMinutes: 20).factsLine, "2,4 km · 20 min")
    }

    func testOpeningHoursGoInVerbatim() {
        // Unparsed on purpose: OSM's syntax is a language of its own,
        // and half-understanding it is how a screen comes to claim a
        // museum is open on a Monday it is not (§15.3).
        let line = spot(openingHours: "Tu-Su 10:00-17:00").factsLine
        XCTAssertTrue(line.hasSuffix("Tu-Su 10:00-17:00"), line)
    }

    func testAnUnnamedPlaceIsStillNamedSomething() {
        XCTAssertEqual(spot(name: nil).displayName, "Unbenannter Ort")
        XCTAssertEqual(spot(name: "").displayName, "Unbenannter Ort")
    }

    func testTheRadiusPickerSaysWhatItAsksFor() {
        XCTAssertEqual(TripExploreDefaults.radiusLabel(2_000), "2,0 km im Umkreis")
        XCTAssertEqual(TripExploreDefaults.radiusLabel(500), "500 m im Umkreis")
    }

    func testTheDefaultRadiusIsOneOfTheChoices() {
        // A picker whose selection is not in its own list shows nothing
        // selected, which reads as "no radius" rather than "5 km".
        XCTAssertTrue(TripExploreDefaults.radiusChoices.contains(TripExploreDefaults.radiusM))
    }

    func testAnAreaKnowsWhatToCallItself() {
        let area = TripExploreArea(label: "San Gimignano", lat: 43.47, lon: 11.04)
        XCTAssertEqual(area, TripExploreArea(label: "San Gimignano", lat: 43.47, lon: 11.04))
        XCTAssertNotEqual(area, TripExploreArea(label: "Hier", lat: 43.47, lon: 11.04))
    }
}
