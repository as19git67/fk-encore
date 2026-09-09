import XCTest
@testable import FKPhotosLib

/// The travel group, as the screen reads it (§3.5).
///
/// What matters here is what is *not* shown: no age where no birth date
/// was given, and no "kürzere Wege" that nobody set. Both would be the
/// app making a statement about a person on its own.
final class TripTravellersTests: XCTestCase {

    private let json = """
    {
      "travellers": [
        { "id": 1, "subjectPersonId": 7, "label": "Kind A",
          "birthDate": "2020-06-15", "shortWalks": false, "ageAtStart": 7 },
        { "id": 2, "subjectPersonId": null, "label": "Oma",
          "birthDate": null, "shortWalks": true, "ageAtStart": null }
      ],
      "on": "2027-07-01",
      "effect": {
        "withChildren": true,
        "limitedMobility": true,
        "reasons": ["Kind A ist bei Reisebeginn unter 10 — kürzere Blöcke und Pausen."]
      }
    }
    """

    private func answer() throws -> TripTravellersResponse {
        try JSONDecoder().decode(TripTravellersResponse.self, from: Data(json.utf8))
    }

    func testAnAgeIsShownAsTheAgeAtTheStartOfTheTrip() throws {
        // Not "today": a trip planned for next summer is planned for the
        // child they will be by then.
        let travellers = try answer().travellers

        XCTAssertEqual(travellers[0].subtitle(startsOn: "2027-07-01"), "7 bei Reisebeginn")
    }

    func testSomebodyWithoutABirthDateGetsNoInventedAge() throws {
        let oma = try answer().travellers[1]

        XCTAssertNil(oma.ageAtStart)
        XCTAssertEqual(oma.subtitle(startsOn: "2027-07-01"), "kürzere Wege")
    }

    func testTheEffectIsCarriedInWordsNotOnlyAsFlags() throws {
        // §3.8: a day that got shorter without saying why reads as a bug.
        let effect = try answer().effect

        XCTAssertTrue(effect.withChildren)
        XCTAssertTrue(effect.limitedMobility)
        XCTAssertEqual(effect.reasons.count, 1)
        XCTAssertTrue(effect.reasons[0].contains("kürzere Blöcke"))
    }

    func testAnUndatedTripShowsNoAgesAtAll() throws {
        let json = """
        { "travellers": [ { "id": 3, "subjectPersonId": null, "label": "Kind B",
            "birthDate": "2020-06-15", "shortWalks": false, "ageAtStart": null } ],
          "on": null,
          "effect": { "withChildren": false, "limitedMobility": false,
                      "reasons": ["Ohne Reisedatum lässt sich kein Alter ausrechnen."] } }
        """
        let answer = try JSONDecoder()
            .decode(TripTravellersResponse.self, from: Data(json.utf8))

        XCTAssertNil(answer.on)
        XCTAssertNil(answer.travellers[0].subtitle(startsOn: nil))
        XCTAssertFalse(answer.effect.withChildren)
    }

    func testASuggestionSaysHowItIsRelatedAndHowOld() throws {
        let json = """
        { "suggestions": [ { "subjectPersonId": 7, "label": "Kind A", "relation": "kind",
            "birthDate": "2020-06-15", "ageAtStart": 7 } ] }
        """
        let offered = try JSONDecoder()
            .decode(TripTravellerSuggestionsResponse.self, from: Data(json.utf8))

        XCTAssertEqual(offered.suggestions[0].id, 7)
        XCTAssertEqual(offered.suggestions[0].subtitle, "kind · 7 bei Reisebeginn")
    }
}
