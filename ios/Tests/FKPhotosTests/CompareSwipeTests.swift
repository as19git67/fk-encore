import CoreGraphics
import XCTest
@testable import FKPhotosLib

/// The fling-to-discard gesture in the compare view. The rule worth pinning is
/// that a discard never points at the partner photo, and that which direction
/// that is depends on how the pair is laid out.
final class CompareSwipeTests: XCTestCase {

    private let minTravel = CompareSwipe.minTravel

    // MARK: - Where the partner is

    func testLandscapePutsThePartnerBesideYou() {
        XCTAssertEqual(
            CompareSwipe.partnerDirection(indexInPair: 0, isPortrait: false), .right
        )
        XCTAssertEqual(
            CompareSwipe.partnerDirection(indexInPair: 1, isPortrait: false), .left
        )
    }

    func testPortraitPutsThePartnerAboveOrBelow() {
        XCTAssertEqual(
            CompareSwipe.partnerDirection(indexInPair: 0, isPortrait: true), .down
        )
        XCTAssertEqual(
            CompareSwipe.partnerDirection(indexInPair: 1, isPortrait: true), .up
        )
    }

    // MARK: - Reading a drag

    func testAShortDragIsNotAFling() {
        // Otherwise a photo would fly away while someone was merely touching it.
        XCTAssertNil(CompareSwipe.flingDirection(dx: 10, dy: 0, minTravel: minTravel))
        XCTAssertNil(CompareSwipe.flingDirection(dx: 0, dy: -63, minTravel: minTravel))
        XCTAssertNil(CompareSwipe.flingDirection(dx: 40, dy: 40, minTravel: minTravel))
    }

    func testTravellingExactlyTheThresholdCounts() {
        XCTAssertEqual(
            CompareSwipe.flingDirection(dx: minTravel, dy: 0, minTravel: minTravel), .right
        )
    }

    func testTheAxisThatMovedFurtherWins() {
        XCTAssertEqual(CompareSwipe.flingDirection(dx: -100, dy: 30, minTravel: minTravel), .left)
        XCTAssertEqual(CompareSwipe.flingDirection(dx: 30, dy: -100, minTravel: minTravel), .up)
        XCTAssertEqual(CompareSwipe.flingDirection(dx: 20, dy: 100, minTravel: minTravel), .down)
    }

    func testAPerfectDiagonalIsHorizontal() {
        // An arbitrary tie-break, but it has to match the web's or the same
        // gesture would discard on one client and do nothing on the other.
        XCTAssertEqual(CompareSwipe.flingDirection(dx: 100, dy: 100, minTravel: minTravel), .right)
        XCTAssertEqual(CompareSwipe.flingDirection(dx: -100, dy: -100, minTravel: minTravel), .left)
    }

    func testAGestureWithNoNumbersInItIsNoGesture() {
        XCTAssertNil(CompareSwipe.flingDirection(dx: .nan, dy: 0, minTravel: minTravel))
        XCTAssertNil(CompareSwipe.flingDirection(dx: 0, dy: .infinity, minTravel: minTravel))
    }

    // MARK: - Discarding

    func testFlingingAwayFromThePartnerDiscards() {
        XCTAssertEqual(
            CompareSwipe.discardDirection(
                indexInPair: 0, isPortrait: false, dx: -100, dy: 0, minTravel: minTravel
            ),
            .left
        )
        XCTAssertEqual(
            CompareSwipe.discardDirection(
                indexInPair: 1, isPortrait: false, dx: 100, dy: 0, minTravel: minTravel
            ),
            .right
        )
    }

    func testFlingingAtThePartnerDoesNothing() {
        // The two photos shoved together says nothing about which to drop.
        XCTAssertNil(CompareSwipe.discardDirection(
            indexInPair: 0, isPortrait: false, dx: 100, dy: 0, minTravel: minTravel
        ))
        XCTAssertNil(CompareSwipe.discardDirection(
            indexInPair: 1, isPortrait: false, dx: -100, dy: 0, minTravel: minTravel
        ))
        XCTAssertNil(CompareSwipe.discardDirection(
            indexInPair: 0, isPortrait: true, dx: 0, dy: 100, minTravel: minTravel
        ))
        XCTAssertNil(CompareSwipe.discardDirection(
            indexInPair: 1, isPortrait: true, dx: 0, dy: -100, minTravel: minTravel
        ))
    }

    func testTheForbiddenDirectionTurnsWithTheLayout() {
        // Down discards the top photo in landscape (the partner is beside it)
        // but is exactly the forbidden move in portrait.
        XCTAssertEqual(
            CompareSwipe.discardDirection(
                indexInPair: 0, isPortrait: false, dx: 0, dy: 100, minTravel: minTravel
            ),
            .down
        )
        XCTAssertNil(CompareSwipe.discardDirection(
            indexInPair: 0, isPortrait: true, dx: 0, dy: 100, minTravel: minTravel
        ))
        // And sideways, which is forbidden in landscape, is free in portrait.
        XCTAssertEqual(
            CompareSwipe.discardDirection(
                indexInPair: 0, isPortrait: true, dx: 100, dy: 0, minTravel: minTravel
            ),
            .right
        )
    }

    func testEveryDirectionButOneCanDiscard() {
        for isPortrait in [true, false] {
            for index in [0, 1] {
                let forbidden = CompareSwipe.partnerDirection(
                    indexInPair: index, isPortrait: isPortrait
                )
                let deltas: [(CompareSwipe.Direction, Double, Double)] = [
                    (.left, -100, 0), (.right, 100, 0), (.up, 0, -100), (.down, 0, 100),
                ]
                for (direction, dx, dy) in deltas {
                    let result = CompareSwipe.discardDirection(
                        indexInPair: index, isPortrait: isPortrait,
                        dx: dx, dy: dy, minTravel: minTravel
                    )
                    XCTAssertEqual(
                        result, direction == forbidden ? nil : direction,
                        "\(direction) at \(index), portrait \(isPortrait)"
                    )
                }
            }
        }
    }

    // MARK: - Leaving the screen

    func testADiscardedTileEndsUpPastTheEdge() {
        let screen = CGSize(width: 400, height: 800)
        let left = CompareSwipe.offscreenOffset(.left, screen: screen)
        XCTAssertLessThanOrEqual(Double(left.width), -400)
        XCTAssertEqual(Double(left.height), 0, accuracy: 0.001)

        let down = CompareSwipe.offscreenOffset(.down, screen: screen)
        XCTAssertGreaterThanOrEqual(Double(down.height), 800)
        XCTAssertEqual(Double(down.width), 0, accuracy: 0.001)
    }

    func testOppositeDirectionsMirrorEachOther() {
        let screen = CGSize(width: 400, height: 800)
        XCTAssertEqual(
            Double(CompareSwipe.offscreenOffset(.right, screen: screen).width),
            -Double(CompareSwipe.offscreenOffset(.left, screen: screen).width),
            accuracy: 0.001
        )
        XCTAssertEqual(
            Double(CompareSwipe.offscreenOffset(.down, screen: screen).height),
            -Double(CompareSwipe.offscreenOffset(.up, screen: screen).height),
            accuracy: 0.001
        )
    }
}
