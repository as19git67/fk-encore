import XCTest
@testable import FKPhotosLib

/// Per-device slideshow settings: the interval the user picks and the caption
/// rule. Playback itself is covered by `SlideshowPlanTests`.
final class SlideshowTests: XCTestCase {

    // MARK: - Interval

    func testDefaultIntervalIsOffered() {
        XCTAssertTrue(Slideshow.intervalOptions.contains(Slideshow.defaultInterval))
    }

    func testIntervalOptionsAreAscendingAndPositive() {
        XCTAssertFalse(Slideshow.intervalOptions.isEmpty)
        XCTAssertEqual(Slideshow.intervalOptions, Slideshow.intervalOptions.sorted())
        XCTAssertTrue(Slideshow.intervalOptions.allSatisfy { $0 > 0 })
    }

    func testNormalizedIntervalKeepsAnOfferedValue() {
        for option in Slideshow.intervalOptions {
            XCTAssertEqual(Slideshow.normalizedInterval(option), option)
        }
    }

    /// A value written by an older build, or an unset default read as 0, must
    /// not drive the timer.
    func testNormalizedIntervalRejectsAnythingElse() {
        XCTAssertEqual(Slideshow.normalizedInterval(0), Slideshow.defaultInterval)
        XCTAssertEqual(Slideshow.normalizedInterval(-5), Slideshow.defaultInterval)
        XCTAssertEqual(Slideshow.normalizedInterval(7), Slideshow.defaultInterval)
        XCTAssertEqual(Slideshow.normalizedInterval(.infinity), Slideshow.defaultInterval)
    }

    func testNormalizedIntervalUsesTheGivenFallback() {
        XCTAssertEqual(Slideshow.normalizedInterval(7, fallback: 10), 10)
    }

    func testLabel() {
        XCTAssertEqual(Slideshow.label(for: 3), "3s")
        XCTAssertEqual(Slideshow.label(for: 30), "30s")
    }

    // MARK: - Caption

    func testCaptionKeepsRealText() {
        XCTAssertEqual(Slideshow.caption("Am Strand"), "Am Strand")
    }

    func testCaptionTrimsSurroundingWhitespace() {
        XCTAssertEqual(Slideshow.caption("  Am Strand \n"), "Am Strand")
    }

    /// Blank-but-present descriptions exist in the data; they must not render
    /// an empty bubble over the photo.
    func testCaptionIsNilWhenThereIsNothingToShow() {
        XCTAssertNil(Slideshow.caption(nil))
        XCTAssertNil(Slideshow.caption(""))
        XCTAssertNil(Slideshow.caption("   "))
        XCTAssertNil(Slideshow.caption("\n\t"))
    }
}
