import XCTest
@testable import FKPhotosLib

/// Pure-logic guards for the toast value type used by the fullscreen action
/// feedback (issue #762). The view layer is verified on-device; these lock the
/// factory → style mapping and value equality the auto-dismiss animation relies on.
final class ToastMessageTests: XCTestCase {

    func testSuccessFactorySetsStyleAndText() {
        let toast = ToastMessage.success("Gespeichert")
        XCTAssertEqual(toast.text, "Gespeichert")
        XCTAssertEqual(toast.style, .success)
    }

    func testErrorFactorySetsStyle() {
        XCTAssertEqual(ToastMessage.error("Fehler").style, .error)
    }

    func testInfoIsDefaultStyle() {
        XCTAssertEqual(ToastMessage(text: "x").style, .info)
    }

    func testEquatabilityDistinguishesStyleAndText() {
        XCTAssertEqual(ToastMessage.success("a"), ToastMessage.success("a"))
        XCTAssertNotEqual(ToastMessage.success("a"), ToastMessage.error("a"))
        XCTAssertNotEqual(ToastMessage.success("a"), ToastMessage.success("b"))
    }
}
