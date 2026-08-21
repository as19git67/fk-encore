import XCTest
@testable import FKPhotosLib

/// Fullscreen slideshow rules (`docs/photo-slideshow.md`). The web keeps the
/// same decisions in `frontend/src/utils/slideshow.ts`; these cover the iOS
/// side of that contract — the no-wrap stop, when the caption may appear, and
/// coercing a stale stored interval.
final class SlideshowTests: XCTestCase {

    // MARK: - Interval options

    func testOffersTheSameIntervalsAsTheWeb() {
        XCTAssertEqual(Slideshow.intervalOptions, [3, 5, 10, 15, 20, 30])
    }

    func testDefaultIntervalIsFiveSeconds() {
        XCTAssertEqual(Slideshow.defaultInterval, 5)
        XCTAssertTrue(Slideshow.intervalOptions.contains(Slideshow.defaultInterval))
    }

    func testKnownIntervalIsKept() {
        XCTAssertEqual(Slideshow.normalizedInterval(10), 10)
    }

    /// A value from an older build would otherwise drive the timer with
    /// something the menu never offers.
    func testUnknownIntervalFallsBackToTheDefault() {
        XCTAssertEqual(Slideshow.normalizedInterval(7), Slideshow.defaultInterval)
        XCTAssertEqual(Slideshow.normalizedInterval(0), Slideshow.defaultInterval)
        XCTAssertEqual(Slideshow.normalizedInterval(-5), Slideshow.defaultInterval)
    }

    func testFallbackIsOverridable() {
        XCTAssertEqual(Slideshow.normalizedInterval(7, fallback: 20), 20)
    }

    func testLabelIsCompactSeconds() {
        XCTAssertEqual(Slideshow.label(for: 3), "3s")
        XCTAssertEqual(Slideshow.label(for: 30), "30s")
    }

    // MARK: - Advancing

    func testAdvancesWhilePlayingWithSomewhereToGo() {
        XCTAssertTrue(Slideshow.shouldAdvance(playing: true, interval: 5, hasNext: true, currentLoaded: true))
    }

    func testDoesNotAdvanceWhenStopped() {
        XCTAssertFalse(Slideshow.shouldAdvance(playing: false, interval: 5, hasNext: true, currentLoaded: true))
    }

    func testDoesNotAdvanceAtTheLastPhoto() {
        XCTAssertFalse(Slideshow.shouldAdvance(playing: true, interval: 5, hasNext: false, currentLoaded: true))
    }

    func testNonPositiveIntervalDisablesAdvancing() {
        XCTAssertFalse(Slideshow.shouldAdvance(playing: true, interval: 0, hasNext: true, currentLoaded: true))
        XCTAssertFalse(Slideshow.shouldAdvance(playing: true, interval: -1, hasNext: true, currentLoaded: true))
    }

    // MARK: - Waiting for the current photo

    /// The gap is meant to be time spent looking at a photo, so it starts once
    /// the photo is up — not while it is still a spinner.
    func testDoesNotAdvanceWhileTheCurrentPhotoIsStillLoading() {
        XCTAssertFalse(Slideshow.shouldAdvance(
            playing: true, interval: 5, hasNext: true, currentLoaded: false
        ))
    }

    /// Waiting on a slow photo is a pause, not a stop: `reachedEnd` stays false
    /// so the view leaves `isPlaying` alone and re-arms once the photo lands.
    func testWaitingForALoadIsNotTreatedAsReachingTheEnd() {
        XCTAssertFalse(Slideshow.shouldAdvance(
            playing: true, interval: 5, hasNext: true, currentLoaded: false
        ))
        XCTAssertFalse(Slideshow.reachedEnd(playing: true, hasNext: true))
    }

    /// Once the photo settles, the same state advances — this is the transition
    /// the view's timer key exists to catch.
    func testAdvancesOnceTheCurrentPhotoSettles() {
        let waiting = Slideshow.shouldAdvance(
            playing: true, interval: 5, hasNext: true, currentLoaded: false
        )
        let settled = Slideshow.shouldAdvance(
            playing: true, interval: 5, hasNext: true, currentLoaded: true
        )
        XCTAssertFalse(waiting)
        XCTAssertTrue(settled)
    }

    /// A load that never completes must not be rescued by the other conditions:
    /// nothing except settling may start the timer.
    func testNoOtherConditionSubstitutesForLoading() {
        for playing in [true, false] {
            for hasNext in [true, false] {
                XCTAssertFalse(
                    Slideshow.shouldAdvance(
                        playing: playing, interval: 5, hasNext: hasNext, currentLoaded: false
                    ),
                    "playing=\(playing) hasNext=\(hasNext)"
                )
            }
        }
    }

    // MARK: - Reaching the end

    /// Running off the end is a real stop, so the button flips back to "play".
    func testReachesEndWhilePlayingWithNoNextPhoto() {
        XCTAssertTrue(Slideshow.reachedEnd(playing: true, hasNext: false))
    }

    func testDoesNotReachEndWhileMorePhotosRemain() {
        XCTAssertFalse(Slideshow.reachedEnd(playing: true, hasNext: true))
    }

    /// A stopped slideshow sitting on the last photo has not just "reached the
    /// end" — nothing should be flipped off.
    func testStoppedAtTheLastPhotoIsNotAnEndTransition() {
        XCTAssertFalse(Slideshow.reachedEnd(playing: false, hasNext: false))
    }

    /// The two predicates must never both hold: the view would arm a timer and
    /// stop playback in the same pass.
    func testAdvanceAndEndAreMutuallyExclusive() {
        for playing in [true, false] {
            for hasNext in [true, false] {
                for loaded in [true, false] {
                    let advancing = Slideshow.shouldAdvance(
                        playing: playing, interval: 5, hasNext: hasNext, currentLoaded: loaded
                    )
                    let ending = Slideshow.reachedEnd(playing: playing, hasNext: hasNext)
                    XCTAssertFalse(
                        advancing && ending,
                        "playing=\(playing) hasNext=\(hasNext) loaded=\(loaded)"
                    )
                }
            }
        }
    }

    // MARK: - Caption

    func testCaptionShowsWhilePlayingWithADescription() {
        XCTAssertTrue(Slideshow.shouldShowCaption(
            playing: true, showDetails: false, description: "Sonnenuntergang"
        ))
    }

    func testCaptionHiddenWhenNotPlaying() {
        XCTAssertFalse(Slideshow.shouldShowCaption(
            playing: false, showDetails: false, description: "Sonnenuntergang"
        ))
    }

    /// The details view already shows the description; doubling it up is noise.
    func testCaptionHiddenWhileDetailsAreOpen() {
        XCTAssertFalse(Slideshow.shouldShowCaption(
            playing: true, showDetails: true, description: "Sonnenuntergang"
        ))
    }

    func testCaptionHiddenWithoutADescription() {
        XCTAssertFalse(Slideshow.shouldShowCaption(
            playing: true, showDetails: false, description: nil
        ))
        XCTAssertFalse(Slideshow.shouldShowCaption(
            playing: true, showDetails: false, description: ""
        ))
    }

    /// A whitespace-only description would render as an empty floating pill.
    func testCaptionHiddenForABlankDescription() {
        XCTAssertFalse(Slideshow.shouldShowCaption(
            playing: true, showDetails: false, description: "   \n\t "
        ))
    }
}
