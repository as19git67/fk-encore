import XCTest
@testable import FKPhotosLib

/// What a failed request says to the traveller.
///
/// One mapping for thirty screens: an outage must read the same
/// everywhere, in German, and a sentence the server wrote for the
/// person must pass through untouched.
final class TripErrorTextTests: XCTestCase {

    func testNoConnectionIsSaidInGerman() {
        let text = TripErrorText.describe(URLError(.notConnectedToInternet))
        XCTAssertTrue(text.hasPrefix("Keine Verbindung"), text)
        XCTAssertFalse(text.lowercased().contains("internet connection"), "no URLError prose")
    }

    func testATimeoutAndAMissingHostAreDifferentSentences() {
        XCTAssertNotEqual(TripErrorText.describe(URLError(.timedOut)),
                          TripErrorText.describe(URLError(.cannotFindHost)))
    }

    func testTheServersOwnSentencePassesThrough() {
        // A refused re-plan comes back as a German sentence written for
        // the traveller; rewording it would lose the reason.
        let text = TripErrorText.describe(
            APIError.httpError(400, "Der Tag hat schon begonnen — Neuplanen geht nicht mehr."))
        XCTAssertEqual(text, "Der Tag hat schon begonnen — Neuplanen geht nicht mehr.")
    }

    func testForbiddenSaysWhoMay() {
        XCTAssertTrue(TripErrorText.describe(APIError.httpError(403, nil)).contains("angelegt hat"))
    }

    func testAServerErrorDoesNotShowItsInternals() {
        let text = TripErrorText.describe(APIError.httpError(500, "TypeError: cannot read x"))
        XCTAssertFalse(text.contains("TypeError"))
    }

    func testACancelledRequestSaysNothing() {
        XCTAssertEqual(TripErrorText.describe(CancellationError()), "")
        XCTAssertEqual(TripErrorText.describe(URLError(.cancelled)), "")
    }
}
