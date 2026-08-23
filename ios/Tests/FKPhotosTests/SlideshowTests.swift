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

    /// The chooser is a list of plain actions with no selection state of its
    /// own, so the interval in use has to be marked in the text.
    func testLabelMarksTheIntervalInUse() {
        XCTAssertEqual(Slideshow.label(for: 5, current: 5), "5s ✓")
        XCTAssertEqual(Slideshow.label(for: 10, current: 5), "10s")
    }

    /// A stored value outside the options drives the timer at the default, so
    /// that is the row the mark belongs on — not none of them.
    func testTheMarkFollowsTheNormalizedValue() {
        XCTAssertEqual(
            Slideshow.label(for: Slideshow.defaultInterval, current: 7),
            "\(Slideshow.label(for: Slideshow.defaultInterval)) ✓"
        )
        XCTAssertEqual(
            Slideshow.intervalOptions.filter {
                Slideshow.label(for: $0, current: 7).hasSuffix("✓")
            },
            [Slideshow.defaultInterval]
        )
    }

    /// Exactly one row is ever marked.
    func testOnlyOneIntervalIsMarked() {
        for current in Slideshow.intervalOptions {
            let marked = Slideshow.intervalOptions.filter {
                Slideshow.label(for: $0, current: current).hasSuffix("✓")
            }
            XCTAssertEqual(marked, [current])
        }
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

/// Per-device music settings for the photo slideshow.
final class SlideshowMusicSettingsTests: XCTestCase {

    /// `@AppStorage` yields "" for a key never written; that is "no preference",
    /// not a track id to match against.
    func testAnUnsetTrackIdIsNil() {
        XCTAssertNil(Slideshow.storedMusicTrackId(""))
        XCTAssertNil(Slideshow.storedMusicTrackId("   "))
        XCTAssertNil(Slideshow.storedMusicTrackId("\n"))
    }

    func testAStoredTrackIdSurvives() {
        XCTAssertEqual(Slideshow.storedMusicTrackId("calm/01_dawn.mp3"), "calm/01_dawn.mp3")
        XCTAssertEqual(Slideshow.storedMusicTrackId(" calm/01_dawn.mp3 "), "calm/01_dawn.mp3")
    }

    /// Unset means "play the music", matching the recaps.
    func testMuteDefaultsToOff() {
        let defaults = UserDefaults(suiteName: "SlideshowMusicSettingsTests")!
        defaults.removePersistentDomain(forName: "SlideshowMusicSettingsTests")
        XCTAssertFalse(Slideshow.storedMusicMuted(defaults))
        defaults.set(true, forKey: Slideshow.musicMutedDefaultsKey)
        XCTAssertTrue(Slideshow.storedMusicMuted(defaults))
        defaults.removePersistentDomain(forName: "SlideshowMusicSettingsTests")
    }

    /// The two keys must not collide with the interval key.
    func testKeysAreDistinct() {
        let keys = Set([
            Slideshow.intervalDefaultsKey,
            Slideshow.musicMutedDefaultsKey,
            Slideshow.musicTrackDefaultsKey,
        ])
        XCTAssertEqual(keys.count, 3)
    }
}
