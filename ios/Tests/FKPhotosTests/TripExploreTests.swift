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

    // MARK: - The questions (§3.1)

    func testEachQuestionSaysItselfAndCarriesAnIcon() {
        // Three, fixed, and matching the server's own vocabulary. Not
        // fetched like the interests: an id the server refuses is a
        // loud failure, a silently different list is not.
        XCTAssertEqual(TripExploreQuestion.allCases.map(\.rawValue), ["rain", "fair", "quick"])
        XCTAssertEqual(TripExploreQuestion.rain.label, "Bei Regen")
        XCTAssertFalse(TripExploreQuestion.quick.symbolName.isEmpty)
    }

    func testAQuestionIsItsOwnWireValue() {
        // What the chip sends is the enum's raw value, so a renamed
        // label can never quietly change the request.
        XCTAssertEqual(TripExploreQuestion(rawValue: "fair"), .fair)
        XCTAssertNil(TripExploreQuestion(rawValue: "montags-offen"))
    }

    // MARK: - What the detail screen is handed

    func testAFoundPlaceBecomesASpotWithItsReasons() {
        // The detail screen a planned spot uses, for a place nobody has
        // kept yet: what it is, where it is, and why it ranked here.
        let detail = TripSpotDetail(spot(openingHours: "Tu-Su 10:00-17:00"))

        XCTAssertEqual(detail.osmRef, "node:1")
        XCTAssertEqual(detail.displayName, "Museo Civico")
        XCTAssertEqual(detail.dwellMinutes, 90)
        XCTAssertEqual(detail.reasons, ["hat einen Wikipedia-Artikel"])
        // Nobody has kept it, so none of these can be anybody's yet.
        XCTAssertNil(detail.title)
        XCTAssertNil(detail.note)
        XCTAssertFalse(detail.photoStop)
        // It came out of the region search, so the map knows it.
        XCTAssertFalse(detail.unmatched)
    }

    private func idea(
        name: String? = "Die Bank am Hang",
        title: String? = nil,
        note: String? = nil,
        unmatched: Bool = true,
        addedBy: String? = nil,
    ) -> TripIdea {
        TripIdea(
            id: 4,
            osmRef: "manual:4",
            name: name,
            title: title,
            lat: 43.47,
            lon: 11.04,
            category: "viewpoint",
            dwellMinutes: 20,
            note: note,
            sourceUrl: nil,
            unmatched: unmatched,
            validFrom: nil,
            validTo: nil,
            addedBy: addedBy,
            addedAt: "2026-09-01T10:00:00Z",
        )
    }

    func testACollectedPlaceKeepsWhatSomebodyWroteAboutIt() {
        let detail = TripSpotDetail(idea(note: "sch\u{00F6}ner Blick", addedBy: "Anna"))

        XCTAssertEqual(detail.note, "sch\u{00F6}ner Blick")
        // Who kept it is the reason it is on the list (§20.1), so it
        // goes where the plan puts its scoring reasons.
        XCTAssertEqual(detail.reasons, ["gemerkt von Anna"])
        XCTAssertTrue(detail.unmatched)
    }

    func testTheFamilysNameWinsAndTheMapsNameStays() {
        // Renaming is the family's shorthand, never a correction of
        // OpenStreetMap — the ticket desk answers to the other one.
        let detail = TripSpotDetail(idea(name: "Panoramaweg", title: "Unsere Bank"))

        XCTAssertEqual(detail.displayName, "Unsere Bank")
        XCTAssertEqual(detail.officialName, "Panoramaweg")
    }

    func testAnEntryNobodyRenamedShowsNoSecondName() {
        let detail = TripSpotDetail(idea(name: "Panoramaweg"))

        XCTAssertEqual(detail.displayName, "Panoramaweg")
        XCTAssertNil(detail.officialName)
    }

    func testAnAreaKnowsWhatToCallItself() {
        let area = TripExploreArea(label: "San Gimignano", lat: 43.47, lon: 11.04)
        XCTAssertEqual(area, TripExploreArea(label: "San Gimignano", lat: 43.47, lon: 11.04))
        XCTAssertNotEqual(area, TripExploreArea(label: "Hier", lat: 43.47, lon: 11.04))
    }
}
