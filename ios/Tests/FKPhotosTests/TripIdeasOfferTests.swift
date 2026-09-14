import XCTest
@testable import FKPhotosLib

/// „Ihr habt vier Ideen für Lissabon gesammelt." (§20.3)
final class TripIdeasOfferTests: XCTestCase {

    private func idea(_ id: Int, leg: Int, inTrip: Bool = false) -> TripIdeaForPlan {
        TripIdeaForPlan(
            id: id, name: "Ort \(id)", lat: 38.7, lon: -9.1, category: "sight", note: nil,
            addedBy: nil, legIndex: leg, distanceM: 500, alreadyInTrip: inTrip,
        )
    }

    private func title(_ leg: Int) -> String { ["Lissabon", "Porto", "Faro"][leg] }

    func testTheSentenceFromTheConcept() {
        let pending = (1...4).map { idea($0, leg: 0) }
        XCTAssertEqual(
            TripIdeasOffer.sentence(pending: pending, legTitle: title),
            "Ihr habt vier Ideen für Lissabon gesammelt.")
    }

    func testOneIdeaIsSingular() {
        XCTAssertEqual(
            TripIdeasOffer.sentence(pending: [idea(1, leg: 1)], legTitle: title),
            "Ihr habt eine Idee für Porto gesammelt.")
    }

    func testSeveralCitiesAreListed() {
        let pending = [idea(1, leg: 0), idea(2, leg: 2), idea(3, leg: 1)]
        XCTAssertEqual(
            TripIdeasOffer.sentence(pending: pending, legTitle: title),
            "Ihr habt drei Ideen für Lissabon, Porto und Faro gesammelt.")
    }

    func testNothingPendingMeansNoSentence() {
        XCTAssertNil(TripIdeasOffer.sentence(pending: [], legTitle: title))
    }

    func testLargeCountsUseDigits() {
        XCTAssertEqual(TripIdeasOffer.numberWord(23), "23")
        XCTAssertEqual(TripIdeasOffer.numberWord(12), "zwölf")
    }

    func testTheSameOfferStaysQuietAndANewIdeaAsksAgain() {
        let defaults = UserDefaults(suiteName: "TripIdeasOfferTests.\(UUID().uuidString)")!
        let memory = TripIdeasOfferMemory(defaults: defaults)

        XCTAssertTrue(memory.shouldOffer(planId: 7, pendingCount: 4))
        memory.dismiss(planId: 7, pendingCount: 4)
        XCTAssertFalse(memory.shouldOffer(planId: 7, pendingCount: 4))
        // A fifth idea collected next week is a new offer.
        XCTAssertTrue(memory.shouldOffer(planId: 7, pendingCount: 5))
        // Nothing pending is never an offer, dismissed or not.
        XCTAssertFalse(memory.shouldOffer(planId: 7, pendingCount: 0))
        // Another trip has its own memory.
        XCTAssertTrue(memory.shouldOffer(planId: 8, pendingCount: 4))
    }
}
