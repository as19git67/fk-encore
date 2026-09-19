import XCTest
@testable import FKPhotosLib

/// The travel group, as the screen reads it (§3.5).
///
/// What matters here is what is *not* shown: no age where no birth date
/// was given, and no "mehr Zeit" that nobody set. Both would be the
/// app making a statement about a person on its own. And who may be
/// taken off here: only somebody without an account.
final class TripTravellersTests: XCTestCase {

    private let json = """
    {
      "travellers": [
        { "id": 1, "userId": 3, "label": "Papa",
          "birthDate": null, "birthDateFromHousehold": false, "shortWalks": false, "ageAtStart": null },
        { "id": 2, "userId": null, "label": "Kind A",
          "birthDate": "2020-06-15", "birthDateFromHousehold": false, "shortWalks": false, "ageAtStart": 7 },
        { "id": 3, "userId": null, "label": "Oma",
          "birthDate": null, "birthDateFromHousehold": false, "shortWalks": true,
          "getsAbout": "wheelchair", "ageAtStart": null }
      ],
      "on": "2027-07-01",
      "effect": {
        "withChildren": true,
        "limitedMobility": true,
        "onWheels": true,
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

        XCTAssertEqual(travellers[1].subtitle(startsOn: "2027-07-01"), "7 bei Reisebeginn")
    }

    func testSomebodyWithoutABirthDateGetsNoInventedAge() throws {
        let oma = try answer().travellers[2]

        XCTAssertNil(oma.ageAtStart)
        // The time flag is the switch's to show, not the subtitle's.
        XCTAssertTrue(oma.shortWalks)
        XCTAssertNil(oma.subtitle(startsOn: "2027-07-01"))
    }

    func testAnAccountSaysSoAndCannotBeTakenOffHere() throws {
        // Whoever plans is on the trip; they leave under "Planen mit",
        // not by a swipe on this screen.
        let papa = try answer().travellers[0]

        XCTAssertEqual(papa.subtitle(startsOn: "2027-07-01"), "plant mit")
        XCTAssertFalse(papa.isRemovableHere)
        XCTAssertTrue(try answer().travellers[1].isRemovableHere)
    }

    func testAnAccountWithABirthDateShowsBoth() throws {
        let json = """
        { "travellers": [ { "id": 4, "userId": 5, "label": "Kind C",
            "birthDate": "2020-06-15", "birthDateFromHousehold": true, "shortWalks": false, "ageAtStart": 7 } ],
          "on": "2027-07-01",
          "effect": { "withChildren": true, "limitedMobility": false, "reasons": [] } }
        """
        let answer = try JSONDecoder()
            .decode(TripTravellersResponse.self, from: Data(json.utf8))

        XCTAssertEqual(answer.travellers[0].subtitle(startsOn: "2027-07-01"), "plant mit · 7 bei Reisebeginn")
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
        { "travellers": [ { "id": 3, "userId": null, "label": "Kind B",
            "birthDate": "2020-06-15", "birthDateFromHousehold": false, "shortWalks": false, "ageAtStart": null } ],
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

    func testHowSomebodyGetsAboutIsRead() throws {
        let answer = try answer()

        XCTAssertEqual(TripGetsAbout.from(answer.travellers[2].getsAbout), .wheelchair)
        XCTAssertEqual(answer.effect.onWheels, true)
    }

    func testABackendThatDoesNotKnowTheFieldStillDecodes() throws {
        // A self-hosted server is updated when its owner gets round to
        // it, so the app has to read the older answer — and read it as
        // "on foot", which plans exactly as before.
        let old = """
        {
          "travellers": [
            { "id": 1, "userId": null, "label": "Oma", "birthDate": null,
              "birthDateFromHousehold": false, "shortWalks": false, "ageAtStart": null }
          ],
          "on": null,
          "effect": { "withChildren": false, "limitedMobility": false, "reasons": [] }
        }
        """
        let answer = try JSONDecoder().decode(
            TripTravellersResponse.self, from: Data(old.utf8))

        XCTAssertNil(answer.travellers[0].getsAbout)
        XCTAssertEqual(TripGetsAbout.from(answer.travellers[0].getsAbout), .foot)
        XCTAssertNil(answer.effect.onWheels)
    }
}
