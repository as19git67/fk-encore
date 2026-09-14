import XCTest
@testable import FKPhotosLib

/// The caption under the Auto/Manuell switch (`docs/ios-trip-mode.md` §7).
final class TripAutoAddHintTests: XCTestCase {

    func testManualIsNotOff() {
        // The one misunderstanding the caption exists to prevent: the
        // album is synchronised in both positions.
        let manual = TripAutoAddCaption.hint(autoAdd: false, albumName: "Küste 2026")
        XCTAssertTrue(manual.contains("synchronisiert"))
        XCTAssertTrue(manual.contains("Küste 2026"))
        XCTAssertTrue(manual.hasPrefix("Manuell"))
    }

    func testAutomaticSaysWherePhotosGo() {
        let auto = TripAutoAddCaption.hint(autoAdd: true, albumName: "Küste 2026")
        XCTAssertTrue(auto.hasPrefix("Automatisch"))
        XCTAssertTrue(auto.contains("iOS-Album"))
        XCTAssertTrue(auto.contains("f4mil-Album"))
    }
}
