import XCTest
@testable import FKPhotosLib

/// The three answers a day trip may give about its own size (§4.5).
final class TripOutingReachTests: XCTestCase {
    func testTheOrdinaryChoiceSendsNothing() throws {
        // The default belongs to the server. Writing today's eight
        // kilometres into the day would freeze this version's number
        // into every plan made with it.
        XCTAssertNil(TripOutingReach.place.radiusM)
    }

    func testTheTwoOtherChoicesSendANumber() throws {
        XCTAssertEqual(TripOutingReach.centre.radiusM, 2_000)
        XCTAssertEqual(TripOutingReach.region.radiusM, 25_000)
    }

    func testADayWithoutARadiusOpensOnTheOrdinaryChoice() throws {
        XCTAssertEqual(TripOutingReach.of(radiusM: nil), .place)
    }

    func testAStoredRadiusOpensOnTheChoiceThatWroteIt() throws {
        // Re-opening the sheet must not silently widen a day somebody
        // narrowed: the round trip is the whole point.
        for reach in TripOutingReach.allCases {
            XCTAssertEqual(TripOutingReach.of(radiusM: reach.radiusM), reach)
        }
    }

    func testARadiusFromSomewhereElseReadsAsTheNearestChoice() throws {
        // The API takes any radius, so a day may carry one this sheet
        // never wrote — from a future version, or from a script.
        XCTAssertEqual(TripOutingReach.of(radiusM: 800), .centre)
        XCTAssertEqual(TripOutingReach.of(radiusM: 8_000), .place)
        XCTAssertEqual(TripOutingReach.of(radiusM: 50_000), .region)
    }

    func testEveryChoiceSaysWhatItDoes() throws {
        // A segmented control of three nouns is unreadable without the
        // sentence under it.
        for reach in TripOutingReach.allCases {
            XCTAssertFalse(reach.label.isEmpty)
            XCTAssertFalse(reach.explanation.isEmpty)
        }
    }
}
