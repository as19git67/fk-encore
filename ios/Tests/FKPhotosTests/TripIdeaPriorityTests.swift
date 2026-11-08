import XCTest
@testable import FKPhotosLib

/// Priority and opening hours on an idea (ideas plan, stage 3).
@MainActor
final class TripIdeaPriorityTests: XCTestCase {
    func testAMissingOrUnknownPriorityIsWill() {
        XCTAssertEqual(TripIdeaPriority(raw: nil), .want)
        XCTAssertEqual(TripIdeaPriority(raw: "soon"), .want)
        XCTAssertEqual(TripIdeaPriority(raw: "must"), .must)
    }

    func testTheAppReadsTheSameHoursAsTheServer() {
        // The same forms `opening-hours.ts` reads; anything else is
        // "Öffnungszeiten unklar", never a guess.
        XCTAssertTrue(TripOpeningHours.isReadable("24/7"))
        XCTAssertTrue(TripOpeningHours.isReadable("Tu-Su 10:00-18:00"))
        XCTAssertTrue(TripOpeningHours.isReadable("Mo-Fr 09:00-12:00,14:00-18:00; Sa 10:00-14:00; Su off"))
        XCTAssertTrue(TripOpeningHours.isReadable("Mo-Sa 10:00-18:00; PH off"))
        XCTAssertFalse(TripOpeningHours.isReadable("Apr-Oct Tu-Su 10:00-18:00"))
        XCTAssertFalse(TripOpeningHours.isReadable("Mo-Fr sunrise-sunset"))
        XCTAssertFalse(TripOpeningHours.isReadable(""))
    }

    func testAClosedDateReadsAsADay() {
        XCTAssertEqual(TripIdeaChips.shortDate("2026-09-07"), "Mo 7.9.")
    }

    func testACandidateDecodesItsPriorityAndHours() throws {
        let json = """
        {"osmRef":"node:7","name":"Beispielmuseum","lat":48.37,"lon":10.9,"category":"museum",
         "dwellMinutes":90,"score":12,"reasons":[],"origin":"manual","note":null,"sourceUrl":null,
         "unmatched":false,"title":null,"localName":null,"wikipediaUrl":null,"photoStop":null,
         "priority":"must","openingHours":"Tu-Su 10:00-18:00","closedOn":["2026-09-07"],"ticket":"So 6.9. 14:00"}
        """
        let candidate = try JSONDecoder().decode(TripCandidate.self, from: Data(json.utf8))
        XCTAssertEqual(candidate.ideaPriority, .must)
        XCTAssertEqual(candidate.closedOn, ["2026-09-07"])
        XCTAssertEqual(candidate.ticket, "So 6.9. 14:00")
    }
}
