import XCTest
@testable import FKPhotosLib

/// Who owns the session the share extension reads.
///
/// The rule looks trivial and the bug it fixes was not: the app mirrored
/// its Keychain pair into the App Group on every launch, over a pair the
/// extension had just rotated. Five minutes of server grace later, the
/// rotated refresh token was gone and the extension asked for a fresh
/// login — for a session that was perfectly valid.
final class SharedSessionTests: XCTestCase {

    func testAnEmptyGroupIsFilled() {
        // First run, or an update from a version that never wrote one.
        XCTAssertTrue(SharedSession.shouldMirror(groupToken: nil, groupRefreshToken: nil))
        XCTAssertTrue(SharedSession.shouldMirror(groupToken: "", groupRefreshToken: ""))
    }

    func testALiveGroupSessionIsLeftAlone() {
        // It is at least as new as the Keychain's: the app writes both
        // halves when it refreshes, so anything newer in the group came
        // from the extension.
        XCTAssertFalse(SharedSession.shouldMirror(
            groupToken: "access", groupRefreshToken: "refresh"))
    }

    func testHalfAPairIsNotASession() {
        // A token with no way to renew it has fifteen minutes to live.
        // Replacing it with a complete pair loses nothing.
        XCTAssertTrue(SharedSession.shouldMirror(
            groupToken: "access", groupRefreshToken: nil))
        XCTAssertTrue(SharedSession.shouldMirror(
            groupToken: nil, groupRefreshToken: "refresh"))
    }
}
