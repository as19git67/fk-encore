import XCTest
@testable import FKPhotosLib

/// Parsing the review-queue deep link (#968 proposal 6) — the target both the
/// feed banner and the notification tap have to agree on.
final class ReviewDeepLinkTests: XCTestCase {

    func testTheCanonicalFormParses() {
        let url = URL(string: "f4milphotos://review-queue")!
        XCTAssertEqual(ReviewDeepLink.parse(url), .reviewQueue)
    }

    func testAPathFormAlsoParses() {
        let url = URL(string: "f4milphotos:/review-queue")!
        XCTAssertEqual(ReviewDeepLink.parse(url), .reviewQueue)
    }

    func testCaseDoesNotMatter() {
        let url = URL(string: "F4milPhotos://Review-Queue")!
        XCTAssertEqual(ReviewDeepLink.parse(url), .reviewQueue)
    }

    func testAnotherSchemeIsRejected() {
        let url = URL(string: "https://review-queue")!
        XCTAssertNil(ReviewDeepLink.parse(url))
    }

    func testAnUnknownHostUnderTheRightSchemeIsRejected() {
        let url = URL(string: "f4milphotos://something-else")!
        XCTAssertNil(ReviewDeepLink.parse(url))
    }

    /// What the notification actually posts — round-tripped, so a change to
    /// one side cannot silently stop matching the other.
    func testTheGeneratedURLParsesBackToItself() {
        XCTAssertEqual(ReviewDeepLink.parse(ReviewDeepLink.reviewQueueURL), .reviewQueue)
    }
}
