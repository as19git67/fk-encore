import XCTest
@testable import FKPhotosLib

/// Opening a stop as the place Apple Maps knows, not as a dot (§9.1).
///
/// The gain is real — opening hours, photos, reviews, the things open
/// data cannot give the planner — and so is the risk: a search for
/// "Frauenkirche" answers with one in every city that has one. Opening
/// the wrong place sends the traveller somewhere else, which is worse
/// than the bare pin this replaces. Hence two independent conditions,
/// and hence these tests.
final class TripAppleMapsLookupTests: XCTestCase {
    private let here = TripCoordinate(lat: 48.1385, lon: 11.5755)

    private func candidate(_ name: String, metresNorth: Double) -> TripAppleMapsLookup.Candidate {
        TripAppleMapsLookup.Candidate(
            name: name,
            coordinate: TripCoordinate(lat: here.lat + metresNorth / 111_320, lon: here.lon))
    }

    func testPicksTheMatchingPlaceNearby() {
        let picked = TripAppleMapsLookup.pick(
            [candidate("Ratskeller", metresNorth: 400), candidate("Beispielkirche", metresNorth: 40)],
            named: "Beispielkirche", near: here)
        XCTAssertEqual(picked?.name, "Beispielkirche")
    }

    func testRefusesTheSameNameInAnotherDistrict() {
        // The mistake that matters. 2 km away is not this church, and a
        // bare pin on the right spot beats a rich page on the wrong one.
        XCTAssertNil(TripAppleMapsLookup.pick(
            [candidate("Beispielkirche", metresNorth: 2_000)],
            named: "Beispielkirche", near: here))
    }

    func testRefusesADifferentPlaceNextDoor() {
        XCTAssertNil(TripAppleMapsLookup.pick(
            [candidate("Apotheke am Markt", metresNorth: 20)],
            named: "Beispielkirche", near: here))
    }

    func testTakesTheNearestOfSeveralMatches() {
        let picked = TripAppleMapsLookup.pick(
            [candidate("Beispielkirche", metresNorth: 250),
             candidate("Beispielkirche (Krypta)", metresNorth: 30)],
            named: "Beispielkirche", near: here)
        XCTAssertEqual(picked?.name, "Beispielkirche (Krypta)")
    }

    func testAcceptsTheLongerNameAppleUses() {
        // OSM says "Beispielkirche", Apple says "Beispielkirche
        // Musterstadt". Not a disagreement — the same place, named
        // twice.
        let picked = TripAppleMapsLookup.pick(
            [candidate("Beispielkirche Musterstadt", metresNorth: 50)],
            named: "Beispielkirche", near: here)
        XCTAssertNotNil(picked)
    }

    func testIgnoresAccentsAndPunctuation() {
        let picked = TripAppleMapsLookup.pick(
            [candidate("Cafe Beispielhof", metresNorth: 30)],
            named: "Café-Beispielhof", near: here)
        XCTAssertNotNil(picked)
    }

    func testAShortNameHasToMatchExactly() {
        // "Zum" inside "Zumsteinhaus" is not a match, and containment
        // on three letters would find one everywhere.
        XCTAssertFalse(TripAppleMapsLookup.namesAgree("zumsteinhaus", "zum"))
        XCTAssertTrue(TripAppleMapsLookup.namesAgree("zum", "zum"))
    }

    func testAnEmptyNameLooksUpNothing() {
        XCTAssertNil(TripAppleMapsLookup.pick(
            [candidate("Irgendwas", metresNorth: 10)], named: "  ", near: here))
    }

    func testNothingToChooseFromIsNoMatch() {
        XCTAssertNil(TripAppleMapsLookup.pick([], named: "Beispielkirche", near: here))
    }
}
