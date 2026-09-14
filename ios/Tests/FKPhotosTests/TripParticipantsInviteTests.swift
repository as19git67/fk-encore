import XCTest
@testable import FKPhotosLib

/// The address check before an invitation (§6.2): enough to catch a
/// typo before the server does, not a full validator.
@MainActor
final class TripParticipantsInviteTests: XCTestCase {

    private func model(_ email: String) -> TripParticipantsViewModel {
        let vm = TripParticipantsViewModel(planId: 1)
        vm.email = email
        return vm
    }

    func testAnOrdinaryAddressPasses() {
        XCTAssertTrue(model("max@beispiel.test").emailLooksValid)
        XCTAssertTrue(model("  max@beispiel.test \n").emailLooksValid, "whitespace is trimmed")
    }

    func testAnAddressWithoutAtOrDotDoesNot() {
        XCTAssertFalse(model("").emailLooksValid)
        XCTAssertFalse(model("max").emailLooksValid)
        XCTAssertFalse(model("max@beispiel").emailLooksValid)
        XCTAssertFalse(model("@beispiel.test").emailLooksValid)
        XCTAssertFalse(model("max@.test").emailLooksValid)
        XCTAssertFalse(model("max@beispiel.").emailLooksValid)
        XCTAssertFalse(model("max@bei@spiel.test").emailLooksValid)
    }
}
