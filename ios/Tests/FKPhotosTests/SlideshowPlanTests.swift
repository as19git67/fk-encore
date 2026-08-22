import CoreGraphics
import XCTest
@testable import FKPhotos

/// Grouping photos into slides, and the playback position that runs over them.
final class SlideshowPlanTests: XCTestCase {

    // MARK: - Orientation

    func testOrientationFromSize() {
        XCTAssertEqual(SlideOrientation(size: CGSize(width: 4032, height: 3024)), .landscape)
        XCTAssertEqual(SlideOrientation(size: CGSize(width: 3024, height: 4032)), .portrait)
        XCTAssertEqual(SlideOrientation(size: CGSize(width: 1000, height: 1000)), .square)
    }

    /// A photo that is only just off square would render as two nearly
    /// full-width letterboxes if it paired, so it counts as square.
    func testNearlySquareCountsAsSquare() {
        XCTAssertEqual(SlideOrientation(size: CGSize(width: 1020, height: 1000)), .square)
        XCTAssertEqual(SlideOrientation(size: CGSize(width: 1000, height: 1020)), .square)
        XCTAssertEqual(SlideOrientation(size: CGSize(width: 1200, height: 1000)), .landscape)
    }

    func testDegenerateSizeIsSquare() {
        XCTAssertEqual(SlideOrientation(size: .zero), .square)
        XCTAssertEqual(SlideOrientation(size: CGSize(width: 100, height: 0)), .square)
    }

    func testScreenOrientation() {
        XCTAssertEqual(ScreenOrientation(size: CGSize(width: 390, height: 844)), .portrait)
        XCTAssertEqual(ScreenOrientation(size: CGSize(width: 844, height: 390)), .landscape)
        // A square (or unknown) screen is treated as the common phone case.
        XCTAssertEqual(ScreenOrientation(size: CGSize(width: 500, height: 500)), .portrait)
    }

    // MARK: - Pairing rule

    func testOnlyCounterOrientedPhotosPair() {
        XCTAssertTrue(SlideshowPlanner.canPair(screen: .portrait, photo: .landscape))
        XCTAssertFalse(SlideshowPlanner.canPair(screen: .portrait, photo: .portrait))
        XCTAssertFalse(SlideshowPlanner.canPair(screen: .portrait, photo: .square))

        XCTAssertTrue(SlideshowPlanner.canPair(screen: .landscape, photo: .portrait))
        XCTAssertFalse(SlideshowPlanner.canPair(screen: .landscape, photo: .landscape))
        XCTAssertFalse(SlideshowPlanner.canPair(screen: .landscape, photo: .square))
    }

    // MARK: - Planning

    private func indices(_ plan: [SlideshowSlide]) -> [[Int]] {
        plan.map(\.photoIndices)
    }

    func testTwoLandscapePhotosShareAPortraitScreen() {
        let plan = SlideshowPlanner.extend(
            plan: [],
            orientations: [.landscape, .landscape],
            screen: .portrait
        )
        XCTAssertEqual(indices(plan), [[0, 1]])
    }

    func testTwoPortraitPhotosShareALandscapeScreen() {
        let plan = SlideshowPlanner.extend(
            plan: [],
            orientations: [.portrait, .portrait],
            screen: .landscape
        )
        XCTAssertEqual(indices(plan), [[0, 1]])
    }

    /// A photo that already fills the screen keeps it to itself.
    func testMatchingOrientationStaysSingle() {
        let plan = SlideshowPlanner.extend(
            plan: [],
            orientations: [.portrait, .portrait, .portrait],
            screen: .portrait
        )
        XCTAssertEqual(indices(plan), [[0], [1], [2]])
    }

    func testAnOddLandscapePhotoIsShownAlone() {
        let plan = SlideshowPlanner.extend(
            plan: [],
            orientations: [.landscape, .landscape, .landscape],
            screen: .portrait
        )
        XCTAssertEqual(indices(plan), [[0, 1], [2]])
    }

    func testAPortraitPhotoBreaksUpALandscapeRun() {
        let plan = SlideshowPlanner.extend(
            plan: [],
            orientations: [.landscape, .portrait, .landscape, .landscape],
            screen: .portrait
        )
        XCTAssertEqual(indices(plan), [[0], [1], [2, 3]])
    }

    func testSquarePhotosNeverPair() {
        let plan = SlideshowPlanner.extend(
            plan: [],
            orientations: [.square, .square],
            screen: .portrait
        )
        XCTAssertEqual(indices(plan), [[0], [1]])
    }

    // MARK: - Planning with photos that have not loaded

    /// The partner may still turn out to be pairable, so planning waits for it
    /// rather than committing the photo alone and having to renumber later.
    func testPlanningStopsAtAnUnknownPartner() {
        let plan = SlideshowPlanner.extend(
            plan: [],
            orientations: [.portrait, .landscape, nil],
            screen: .portrait
        )
        XCTAssertEqual(indices(plan), [[0]])
    }

    /// A photo that cannot pair anyway needs no partner to be committed.
    func testAnUnpairablePhotoIsPlannedWithoutItsNeighbour() {
        let plan = SlideshowPlanner.extend(
            plan: [],
            orientations: [.portrait, .portrait, nil],
            screen: .portrait
        )
        XCTAssertEqual(indices(plan), [[0], [1]])
    }

    /// The last photo has no partner to wait for.
    func testALastLandscapePhotoIsPlannedImmediately() {
        let plan = SlideshowPlanner.extend(
            plan: [],
            orientations: [.landscape],
            screen: .portrait
        )
        XCTAssertEqual(indices(plan), [[0]])
    }

    /// Forcing unblocks the photo that is holding planning up — and only that
    /// one. Flattening the whole remainder into singles would throw away every
    /// pairing still to come.
    func testForcingCommitsOnlyTheBlockingPhoto() {
        let plan = SlideshowPlanner.extend(
            plan: [],
            orientations: [nil, .landscape, nil],
            screen: .portrait,
            force: true
        )
        XCTAssertEqual(indices(plan), [[0]])
    }

    /// After the forced photo, planning carries on by the normal rules.
    func testForcingStillPairsWhatItCan() {
        let plan = SlideshowPlanner.extend(
            plan: [],
            orientations: [nil, .landscape, .landscape],
            screen: .portrait,
            force: true
        )
        XCTAssertEqual(indices(plan), [[0], [1, 2]])
    }

    /// Slides already on screen must never renumber, so extending only ever
    /// appends.
    func testExtendingKeepsWhatWasAlreadyPlanned() {
        let first = SlideshowPlanner.extend(
            plan: [],
            orientations: [.landscape, .landscape, nil, nil],
            screen: .portrait
        )
        XCTAssertEqual(indices(first), [[0, 1]])

        let second = SlideshowPlanner.extend(
            plan: first,
            orientations: [.landscape, .landscape, .landscape, .landscape],
            screen: .portrait
        )
        XCTAssertEqual(indices(second), [[0, 1], [2, 3]])
    }

    func testPlannedPhotoCount() {
        let plan = [
            SlideshowSlide(photoIndices: [0, 1]),
            SlideshowSlide(photoIndices: [2]),
        ]
        XCTAssertEqual(SlideshowPlanner.plannedPhotoCount(plan), 3)
        XCTAssertEqual(SlideshowPlanner.plannedPhotoCount([]), 0)
    }

    /// Every photo lands in exactly one slide, in order — whatever the shapes.
    func testPlanCoversEveryPhotoExactlyOnceInOrder() {
        let shapes: [SlideOrientation] = [.portrait, .landscape, .square]
        for screen in [ScreenOrientation.portrait, .landscape] {
            for a in shapes {
                for b in shapes {
                    for c in shapes {
                        let plan = SlideshowPlanner.extend(
                            plan: [],
                            orientations: [a, b, c],
                            screen: screen
                        )
                        XCTAssertEqual(plan.flatMap(\.photoIndices), [0, 1, 2])
                        XCTAssertTrue(plan.allSatisfy { (1...2).contains($0.photoIndices.count) })
                    }
                }
            }
        }
    }

    // MARK: - Playback

    private let full = [
        SlideshowSlide(photoIndices: [0, 1]),
        SlideshowSlide(photoIndices: [2]),
    ]

    func testStartsAtTheFirstSlide() {
        let p = SlideshowPlayback()
        XCTAssertEqual(p.slideIndex, 0)
        XCTAssertEqual(p.progress, 0)
        XCTAssertFalse(p.finished)
    }

    func testTickAdvancesAcrossSlides() {
        var p = SlideshowPlayback()
        p.tick(delta: 4, perSlide: 4, slideCount: 2, planComplete: true)
        XCTAssertEqual(p.slideIndex, 1)
        XCTAssertEqual(p.progress, 0, accuracy: 0.0001)
    }

    func testTickCarriesLeftoverProgress() {
        var p = SlideshowPlayback()
        p.tick(delta: 5, perSlide: 4, slideCount: 2, planComplete: true)
        XCTAssertEqual(p.slideIndex, 1)
        XCTAssertEqual(p.progress, 0.25, accuracy: 0.0001)
    }

    func testFinishesAfterTheLastSlide() {
        var p = SlideshowPlayback()
        p.tick(delta: 10, perSlide: 4, slideCount: 2, planComplete: true)
        XCTAssertTrue(p.finished)
        XCTAssertEqual(p.progress, 1)
    }

    /// Running out of *planned* slides is not the end of the show — the plan
    /// may still be growing, so playback parks until it does.
    func testHoldsAtTheEndOfAnIncompletePlan() {
        var p = SlideshowPlayback()
        p.tick(delta: 10, perSlide: 4, slideCount: 1, planComplete: false)
        XCTAssertFalse(p.finished)
        XCTAssertEqual(p.slideIndex, 0)
        XCTAssertEqual(p.progress, 1)

        // Once the plan grows, the parked show moves on.
        p.tick(delta: 0.05, perSlide: 4, slideCount: 2, planComplete: true)
        XCTAssertEqual(p.slideIndex, 1)
        XCTAssertFalse(p.finished)
    }

    func testTickIgnoresNonsenseInput() {
        var p = SlideshowPlayback()
        p.tick(delta: 1, perSlide: 0, slideCount: 2, planComplete: true)
        p.tick(delta: 0, perSlide: 4, slideCount: 2, planComplete: true)
        p.tick(delta: 1, perSlide: 4, slideCount: 0, planComplete: true)
        XCTAssertEqual(p.slideIndex, 0)
        XCTAssertEqual(p.progress, 0)
    }

    func testNextJumpsAndResetsProgress() {
        var p = SlideshowPlayback()
        p.tick(delta: 2, perSlide: 4, slideCount: 2, planComplete: true)
        p.next(slideCount: 2, planComplete: true)
        XCTAssertEqual(p.slideIndex, 1)
        XCTAssertEqual(p.progress, 0)
    }

    func testNextOnTheLastSlideEndsTheShow() {
        var p = SlideshowPlayback()
        p.next(slideCount: 1, planComplete: true)
        XCTAssertTrue(p.finished)
    }

    /// An impatient tap must not cut a show short whose remaining photos are
    /// still being planned.
    func testNextWaitsWhenThePlanIsIncomplete() {
        var p = SlideshowPlayback()
        p.next(slideCount: 1, planComplete: false)
        XCTAssertFalse(p.finished)
        XCTAssertEqual(p.slideIndex, 0)
    }

    func testPreviousClampsAtTheFirstSlide() {
        var p = SlideshowPlayback()
        p.previous()
        XCTAssertEqual(p.slideIndex, 0)
        XCTAssertEqual(p.progress, 0)
    }

    func testPreviousReopensAFinishedShow() {
        var p = SlideshowPlayback()
        p.next(slideCount: 2, planComplete: true)
        p.next(slideCount: 2, planComplete: true)
        XCTAssertTrue(p.finished)
        p.previous()
        XCTAssertFalse(p.finished)
        XCTAssertEqual(p.slideIndex, 0)
    }

    func testCurrentSlide() {
        var p = SlideshowPlayback()
        XCTAssertEqual(p.currentSlide(in: full)?.photoIndices, [0, 1])
        p.next(slideCount: full.count, planComplete: true)
        XCTAssertEqual(p.currentSlide(in: full)?.photoIndices, [2])
        XCTAssertNil(p.currentSlide(in: []))
    }

    // MARK: - Progress bar

    /// The bar has one segment per photo, so it keeps its shape while the plan
    /// is still growing. Both segments of a pair fill together.
    func testBothSegmentsOfAPairFillTogether() {
        var p = SlideshowPlayback()
        p.tick(delta: 2, perSlide: 4, slideCount: full.count, planComplete: true)
        XCTAssertEqual(p.fillFraction(forPhotoAt: 0, plan: full), 0.5, accuracy: 0.0001)
        XCTAssertEqual(p.fillFraction(forPhotoAt: 1, plan: full), 0.5, accuracy: 0.0001)
        XCTAssertEqual(p.fillFraction(forPhotoAt: 2, plan: full), 0)
    }

    func testPastSegmentsAreFull() {
        var p = SlideshowPlayback()
        p.next(slideCount: full.count, planComplete: true)
        XCTAssertEqual(p.fillFraction(forPhotoAt: 0, plan: full), 1)
        XCTAssertEqual(p.fillFraction(forPhotoAt: 1, plan: full), 1)
        XCTAssertEqual(p.fillFraction(forPhotoAt: 2, plan: full), 0)
    }

    /// Photos the planner has not reached yet are always still ahead.
    func testUnplannedSegmentsAreEmpty() {
        let p = SlideshowPlayback()
        XCTAssertEqual(p.fillFraction(forPhotoAt: 7, plan: full), 0)
    }

    // MARK: - Ken Burns

    /// A photo always drifts the same way, in any show it appears in.
    func testMotionIsDeterministicPerPhoto() {
        XCTAssertEqual(
            KenBurnsMotion.make(seed: 42, focused: false),
            KenBurnsMotion.make(seed: 42, focused: false)
        )
        XCTAssertNotEqual(
            KenBurnsMotion.make(seed: 42, focused: false),
            KenBurnsMotion.make(seed: 43, focused: false)
        )
    }

    /// The motion always runs between the two fixed zoom levels, in one
    /// direction or the other — never a scale below the overscan the pan needs.
    func testMotionZoomsBetweenTheOverscanBounds() {
        for seed in 0..<50 {
            let m = KenBurnsMotion.make(seed: seed, focused: false)
            XCTAssertEqual(Swift.min(m.fromScale, m.toScale), 1.06, accuracy: 0.0001)
            XCTAssertEqual(Swift.max(m.fromScale, m.toScale), 1.18, accuracy: 0.0001)
        }
    }

    func testPanStaysWithinTheOverscanAmplitude() {
        for seed in 0..<50 {
            let m = KenBurnsMotion.make(seed: seed, focused: false)
            for offset in [m.fromX, m.fromY, m.toX, m.toY] {
                XCTAssertLessThanOrEqual(abs(offset), KenBurnsMotion.amplitude)
            }
        }
    }

    /// With a face to aim at, the zoomed-in end of the run sits exactly on the
    /// focal crop — the motion resolves onto the face instead of wandering off
    /// to whatever the random offset happened to pick.
    func testMotionEndsOnTheFocalPointWhenThereIsOne() {
        for seed in 0..<50 {
            let m = KenBurnsMotion.make(seed: seed, focused: true)
            if m.toScale > m.fromScale {
                XCTAssertEqual(m.toX, 0)
                XCTAssertEqual(m.toY, 0)
            } else {
                XCTAssertEqual(m.fromX, 0)
                XCTAssertEqual(m.fromY, 0)
            }
        }
    }

    /// Without one, both ends wander — there is nothing to aim at.
    func testMotionWithoutAFocalPointIsNotPinned() {
        let pinned = (0..<50).filter { seed in
            let m = KenBurnsMotion.make(seed: seed, focused: false)
            return (m.toX == 0 && m.toY == 0) || (m.fromX == 0 && m.fromY == 0)
        }
        XCTAssertTrue(pinned.isEmpty)
    }

    // MARK: - Focal crop

    /// A focal point at the centre is what `scaledToFill` does anyway.
    func testCentredFocalPointDoesNotShiftTheCrop() {
        let offset = KenBurnsSlide.focalOffset(
            focal: CGPoint(x: 0.5, y: 0.5),
            imageSize: CGSize(width: 4000, height: 3000),
            containerSize: CGSize(width: 400, height: 800)
        )
        XCTAssertEqual(offset.width, 0, accuracy: 0.0001)
        XCTAssertEqual(offset.height, 0, accuracy: 0.0001)
    }

    /// A face on the left pulls the crop right, so the face comes into view.
    func testOffCentreFocalPointShiftsTheCrop() {
        let offset = KenBurnsSlide.focalOffset(
            focal: CGPoint(x: 0.1, y: 0.5),
            imageSize: CGSize(width: 4000, height: 3000),
            containerSize: CGSize(width: 400, height: 800)
        )
        XCTAssertGreaterThan(offset.width, 0)
        XCTAssertEqual(offset.height, 0, accuracy: 0.0001)
    }

    /// The shift is bounded by the fill overflow: even a focal point at the
    /// very edge only aligns the image edge with the container edge.
    func testCropShiftIsBoundedByTheOverflow() {
        let container = CGSize(width: 400, height: 800)
        let image = CGSize(width: 4000, height: 3000)
        let scale = max(container.width / image.width, container.height / image.height)
        let overflowX = image.width * scale - container.width
        let offset = KenBurnsSlide.focalOffset(
            focal: CGPoint(x: 0, y: 0.5),
            imageSize: image,
            containerSize: container
        )
        XCTAssertEqual(offset.width, overflowX / 2, accuracy: 0.0001)
    }

    func testNoFocalPointMeansNoShift() {
        let offset = KenBurnsSlide.focalOffset(
            focal: nil,
            imageSize: CGSize(width: 4000, height: 3000),
            containerSize: CGSize(width: 400, height: 800)
        )
        XCTAssertEqual(offset, .zero)
    }

    func testDegenerateSizesMeanNoShift() {
        XCTAssertEqual(
            KenBurnsSlide.focalOffset(
                focal: CGPoint(x: 0.2, y: 0.2),
                imageSize: .zero,
                containerSize: CGSize(width: 400, height: 800)
            ),
            .zero
        )
        XCTAssertEqual(
            KenBurnsSlide.focalOffset(
                focal: CGPoint(x: 0.2, y: 0.2),
                imageSize: CGSize(width: 400, height: 800),
                containerSize: .zero
            ),
            .zero
        )
    }
}
