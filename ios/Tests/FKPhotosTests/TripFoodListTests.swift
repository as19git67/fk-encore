import XCTest
@testable import FKPhotosLib

/// How a place to eat reads on a row (§10.3).
///
/// The rule these tests exist for is one line of the concept: open data
/// knows a restaurant exists, not whether it is any good, and a missing
/// tag is **unknown**, never "no". A row that rendered an untagged place
/// with a crossed-out leaf would invent a fact about it — and the list
/// would quietly become a judgement, which is exactly what it must not
/// be.
final class TripFoodListTests: XCTestCase {

    private func decode(_ json: String) throws -> [FoodPlace] {
        try JSONDecoder().decode(NearbyFoodResponse.self, from: json.data(using: .utf8)!).places
    }

    /// Invented places near an invented square.
    private let response = """
    { "region": "nom_west", "consideredCount": 5, "places": [
        { "osmRef": "node:1", "name": "Trattoria Beispiel", "lat": 48.371, "lon": 10.901,
          "distanceM": 80, "kind": "amenity=restaurant", "categories": ["food"],
          "cuisine": "italian;pizza", "openingHours": "Tu-Su 11:30-22:00",
          "dietVegetarian": "yes", "dietVegan": "limited", "outdoorSeating": "yes",
          "wheelchair": "limited", "phone": "+49 000 0000000",
          "website": "beispiel.test/trattoria" },
        { "osmRef": "node:2", "name": null, "lat": 48.372, "lon": 10.902,
          "distanceM": 2300, "kind": "amenity=fast_food", "categories": ["food"],
          "cuisine": null, "openingHours": null, "dietVegetarian": null, "dietVegan": null,
          "outdoorSeating": null, "wheelchair": null, "phone": null, "website": null },
        { "osmRef": "node:3", "name": "Nur Grün", "lat": 48.373, "lon": 10.903,
          "distanceM": 210, "kind": "amenity=restaurant", "categories": ["food"],
          "cuisine": null, "openingHours": null, "dietVegetarian": "only", "dietVegan": "only",
          "outdoorSeating": null, "wheelchair": "yes", "phone": "0000 / 12 34",
          "website": "https://beispiel.test/gruen" },
        { "osmRef": "node:4", "name": "Steakhaus Muster", "lat": 48.374, "lon": 10.904,
          "distanceM": 300, "kind": "amenity=restaurant", "categories": ["food"],
          "cuisine": null, "openingHours": null, "dietVegetarian": "no", "dietVegan": "no",
          "outdoorSeating": "no", "wheelchair": "no", "phone": "", "website": "" }
    ] }
    """

    func testDecodesTheList() throws {
        let places = try decode(response)
        XCTAssertEqual(places.count, 4)
        XCTAssertEqual(places[0].osmRef, "node:1")
    }

    func testAnUntaggedPlaceGetsNoAttributeLineAtAll() throws {
        // Not a row of crossed-out icons: nobody has said anything about
        // this place, and the row must not say anything either.
        let places = try decode(response)
        XCTAssertNil(places[1].attributeLine)
        XCTAssertEqual(places[1].displayName, "Unbenanntes Lokal")
    }

    func testANegativeTagIsAlsoLeftOffTheLine() throws {
        // "no" is a real fact, but "not vegan" is not what the line is
        // for — it lists what a place offers, not what it lacks.
        let steakhouse = try decode(response)[3]
        XCTAssertNil(steakhouse.attributeLine)
    }

    func testTheLineCarriesWhatIsActuallyTagged() throws {
        let trattoria = try decode(response)[0]
        let line = try XCTUnwrap(trattoria.attributeLine)
        XCTAssertTrue(line.contains("italian, pizza"), line)   // ; is OSM's separator
        XCTAssertTrue(line.contains("vegan (begrenzt)"), line)  // "limited" survives
        XCTAssertTrue(line.contains("vegetarisch"), line)
        XCTAssertTrue(line.contains("draußen"), line)
        XCTAssertTrue(line.contains("teilweise stufenlos"), line)
    }

    func testOnlyIsStrongerThanYesAndSaysSo() throws {
        let green = try decode(response)[2]
        let line = try XCTUnwrap(green.attributeLine)
        XCTAssertTrue(line.contains("nur vegan"), line)
        XCTAssertTrue(line.contains("stufenlos"), line)
        XCTAssertFalse(line.contains("teilweise"), line)
    }

    func testDietLabelsCoverEveryValueOSMUses() {
        XCTAssertEqual(FoodPlace.dietLabel("yes", affirmative: "vegan"), "vegan")
        XCTAssertEqual(FoodPlace.dietLabel("only", affirmative: "vegan"), "nur vegan")
        XCTAssertEqual(FoodPlace.dietLabel("limited", affirmative: "vegan"), "vegan (begrenzt)")
        XCTAssertNil(FoodPlace.dietLabel("no", affirmative: "vegan"))
        XCTAssertNil(FoodPlace.dietLabel(nil, affirmative: "vegan"))
        // An unexpected value is unknown, not a yes.
        XCTAssertNil(FoodPlace.dietLabel("vielleicht", affirmative: "vegan"))
    }

    func testDistanceReadsAsMetresThenKilometres() throws {
        // Metres below a kilometre, one decimal above it. The fixtures
        // sit away from the rounding boundary on purpose: 1450 m lands
        // on a float artefact ("1.4 km", because 1.45 as a double is a
        // hair under), and pinning that would test the formatter rather
        // than the rule.
        let places = try decode(response)
        XCTAssertEqual(places[0].distanceLabel, "80 m")
        XCTAssertEqual(places[1].distanceLabel, "2.3 km")
    }

    func testPhoneLinksStripWhatDiallingCannotUse() throws {
        let places = try decode(response)
        XCTAssertEqual(places[0].phoneURL?.absoluteString, "tel:+490000000000")
        // OSM carries all sorts of formatting: spaces, slashes, groups.
        XCTAssertEqual(places[2].phoneURL?.absoluteString, "tel:00001234")
        // An empty tag is not a phone number.
        XCTAssertNil(places[3].phoneURL)
        XCTAssertNil(places[1].phoneURL)
    }

    func testBareHostnamesStillBecomeLinks() throws {
        let places = try decode(response)
        XCTAssertEqual(places[0].websiteURL?.absoluteString, "https://beispiel.test/trattoria")
        XCTAssertEqual(places[2].websiteURL?.absoluteString, "https://beispiel.test/gruen")
        XCTAssertNil(places[3].websiteURL)
    }
}
