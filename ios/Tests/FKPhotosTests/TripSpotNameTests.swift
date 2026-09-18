import XCTest
@testable import FKPhotosLib

/// A place's two names on one line (§10.4).
final class TripSpotNameTests: XCTestCase {

    func testTheLocalNameGoesInBracketsBehindTheReadableOne() {
        // The name to plan with, and the name on the ticket.
        XCTAssertEqual(TripSpotName.line("Kolosseum", local: "Colosseo"),
                       "Kolosseum (Colosseo)")
    }

    func testAPlaceWithOneNameKeepsOneName() {
        XCTAssertEqual(TripSpotName.line("Marienplatz", local: nil), "Marienplatz")
        XCTAssertEqual(TripSpotName.line("Marienplatz", local: ""), "Marienplatz")
        XCTAssertEqual(TripSpotName.line("Marienplatz", local: "   "), "Marienplatz")
    }

    func testTheSameNameIsNotPrintedTwice() {
        // "Marienplatz (Marienplatz)" reads like two places.
        XCTAssertEqual(TripSpotName.line("Marienplatz", local: "Marienplatz"), "Marienplatz")
        XCTAssertEqual(TripSpotName.line("Marienplatz", local: "marienplatz"), "Marienplatz")
    }

    func testAScriptNobodyCanReadIsStillWorthCarrying() {
        // It is what is written above the door.
        XCTAssertEqual(TripSpotName.line("Nationalmuseum Tokio", local: "東京国立博物館"),
                       "Nationalmuseum Tokio (東京国立博物館)")
    }
}
