import XCTest
@testable import FKPhotosLib

/// The weather's offer, as the day screen reads it (§7.2, §7.1).
///
/// The rule this side has to keep is the one about consent: an offer
/// is an offer. Two things would be wrong quietly — a proposal shown
/// as if the day had already changed, and "nothing to do" shown as an
/// empty list instead of a sentence.
final class TripWeatherReplanTests: XCTestCase {

    private func decodeProposal(_ json: String) throws -> TripWeatherProposal {
        try JSONDecoder().decode(TripWeatherProposal.self, from: Data(json.utf8))
    }

    func testAnOfferCarriesTheMovesByName() throws {
        let proposal = try decodeProposal("""
        {"offered":true,"reason":"ok","moves":[
          {"osmRef":"way:1","name":"Aussichtspunkt","fromBlockId":"afternoon",
           "toBlockId":null,"reason":"wet"},
          {"osmRef":"way:2","name":"Museum","fromBlockId":"morning",
           "toBlockId":"afternoon","reason":"wet"}
        ]}
        """)

        XCTAssertTrue(proposal.offered)
        XCTAssertNil(proposal.blockedSentence)
        XCTAssertEqual(proposal.moves.map(\.displayName), ["Aussichtspunkt", "Museum"])
        // Nil means the pool: out of the day, not out of the trip.
        XCTAssertNil(proposal.moves[0].toBlockId)
        XCTAssertEqual(proposal.moves[1].toBlockId, "afternoon")
    }

    func testEveryRefusalHasItsOwnSentence() throws {
        // "Nichts zu tun" and "keine Vorhersage" are different answers,
        // and a screen that renders both as an empty list loses the
        // distinction §15.3 is built on.
        let noDates = try decodeProposal("""
        {"offered":false,"reason":"no-dates","moves":[]}
        """)
        let noForecast = try decodeProposal("""
        {"offered":false,"reason":"no-forecast","moves":[]}
        """)
        let nothing = try decodeProposal("""
        {"offered":false,"reason":"nothing-to-move","moves":[]}
        """)

        XCTAssertNotNil(noDates.blockedSentence)
        XCTAssertNotNil(noForecast.blockedSentence)
        XCTAssertNotNil(nothing.blockedSentence)
        XCTAssertNotEqual(noDates.blockedSentence, noForecast.blockedSentence)
        XCTAssertNotEqual(noForecast.blockedSentence, nothing.blockedSentence)
    }

    func testAnUnnamedSpotStillReadsAsSomething() throws {
        let proposal = try decodeProposal("""
        {"offered":true,"reason":"ok","moves":[
          {"osmRef":"node:7","name":null,"fromBlockId":"morning",
           "toBlockId":null,"reason":"budget"}
        ]}
        """)

        XCTAssertEqual(proposal.moves[0].displayName, "Unbenannter Ort")
        XCTAssertEqual(proposal.moves[0].id, "node:7")
    }

    func testApplyingAnswersWithThePlanAndWhatItDid() throws {
        // The apply call recomputes rather than replaying the offer, so
        // the moves it answers with are the ones that happened.
        let json = """
        {"plan":{"id":4,"ownerId":1,"title":null,"constraints":null,"legs":[]},
         "moves":[{"osmRef":"way:9","name":"Park","fromBlockId":"afternoon",
                   "toBlockId":null,"reason":"wet"}]}
        """
        let response = try JSONDecoder().decode(
            TripWeatherApplyResponse.self, from: Data(json.utf8))

        XCTAssertEqual(response.plan.id, 4)
        XCTAssertEqual(response.moves.map(\.osmRef), ["way:9"])
    }
}
