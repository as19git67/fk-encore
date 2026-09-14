import XCTest
@testable import FKPhotosLib

/// The hand-off from the App Shortcut to the Trip tab (plan item E3).
@MainActor
final class TripIdeaCaptureRequestTests: XCTestCase {

    override func tearDown() {
        _ = TripIdeaCaptureRequest.shared.consume()
        super.tearDown()
    }

    func testNothingWaitsUntilSomethingIsAsked() {
        XCTAssertFalse(TripIdeaCaptureRequest.shared.isRequested)
        XCTAssertFalse(TripIdeaCaptureRequest.shared.consume())
    }

    func testARequestIsTakenExactlyOnce() {
        // Two views observe the flag; only one of them may open the sheet.
        TripIdeaCaptureRequest.shared.request()
        XCTAssertTrue(TripIdeaCaptureRequest.shared.isRequested)

        XCTAssertTrue(TripIdeaCaptureRequest.shared.consume())
        XCTAssertFalse(TripIdeaCaptureRequest.shared.consume())
        XCTAssertFalse(TripIdeaCaptureRequest.shared.isRequested)
    }
}
