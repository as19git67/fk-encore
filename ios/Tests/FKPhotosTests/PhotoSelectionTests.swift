import XCTest
import CoreGraphics
@testable import FKPhotosLib

/// Multi-select transitions in the photo grids. The awkward states — entering
/// from a long press, deselecting the last photo, dragging back over an
/// already-picked thumbnail — are the ones a user hits constantly and a view
/// cannot assert about, so they live here.
final class PhotoSelectionTests: XCTestCase {

    // MARK: - Entering selection

    func testStartsIdle() {
        let selection = PhotoSelection()
        XCTAssertFalse(selection.isSelecting)
        XCTAssertTrue(selection.isEmpty)
        XCTAssertEqual(selection.count, 0)
    }

    /// Toolbar entry: selection mode with nothing picked, so the batch buttons
    /// start disabled.
    func testEnterSelectsNothing() {
        var selection = PhotoSelection()
        selection.enter()
        XCTAssertTrue(selection.isSelecting)
        XCTAssertTrue(selection.isEmpty)
    }

    /// Long-press entry: the photo that was pressed has to end up selected,
    /// otherwise the gesture appears to do nothing.
    func testBeginSelectsThePressedPhoto() {
        var selection = PhotoSelection()
        selection.begin(with: 42)
        XCTAssertTrue(selection.isSelecting)
        XCTAssertTrue(selection.contains(42))
        XCTAssertEqual(selection.count, 1)
    }

    // MARK: - Toggling

    func testToggleAddsThenRemoves() {
        var selection = PhotoSelection()
        selection.enter()
        selection.toggle(1)
        XCTAssertTrue(selection.contains(1))
        selection.toggle(2)
        XCTAssertEqual(selection.count, 2)
        selection.toggle(1)
        XCTAssertFalse(selection.contains(1))
        XCTAssertEqual(selection.count, 1)
    }

    /// Deselecting the last photo leaves selection mode, so the user is never
    /// stranded in an empty selection they have to cancel by hand.
    func testDeselectingTheLastPhotoLeavesSelectionMode() {
        var selection = PhotoSelection()
        selection.begin(with: 7)
        selection.toggle(7)
        XCTAssertFalse(selection.isSelecting)
        XCTAssertTrue(selection.isEmpty)
    }

    func testDeselectingANonLastPhotoStaysInSelectionMode() {
        var selection = PhotoSelection()
        selection.begin(with: 7)
        selection.toggle(8)
        selection.toggle(7)
        XCTAssertTrue(selection.isSelecting)
        XCTAssertEqual(selection.count, 1)
        XCTAssertTrue(selection.contains(8))
    }

    // MARK: - Cancelling

    func testCancelClearsEverything() {
        var selection = PhotoSelection()
        selection.begin(with: 1)
        selection.toggle(2)
        selection.cancel()
        XCTAssertFalse(selection.isSelecting)
        XCTAssertTrue(selection.isEmpty)
    }

    // MARK: - Drag to select

    private var frames: [Int: CGRect] {
        [
            1: CGRect(x: 0, y: 0, width: 100, height: 100),
            2: CGRect(x: 100, y: 0, width: 100, height: 100),
            3: CGRect(x: 200, y: 0, width: 100, height: 100),
        ]
    }

    func testDragSelectsThePhotoUnderThePoint() {
        var selection = PhotoSelection()
        selection.enter()
        selection.selectItems(at: CGPoint(x: 150, y: 50), frames: frames)
        XCTAssertEqual(selection.ids, [2])
    }

    func testDragAccumulatesAcrossPoints() {
        var selection = PhotoSelection()
        selection.enter()
        selection.selectItems(at: CGPoint(x: 50, y: 50), frames: frames)
        selection.selectItems(at: CGPoint(x: 150, y: 50), frames: frames)
        selection.selectItems(at: CGPoint(x: 250, y: 50), frames: frames)
        XCTAssertEqual(selection.ids, [1, 2, 3])
    }

    /// Dragging back over a photo already picked must not unpick it — a
    /// wobbling finger would otherwise undo its own selection.
    func testDragOverAnAlreadySelectedPhotoKeepsIt() {
        var selection = PhotoSelection()
        selection.begin(with: 1)
        selection.selectItems(at: CGPoint(x: 50, y: 50), frames: frames)
        XCTAssertTrue(selection.contains(1))
        XCTAssertEqual(selection.count, 1)
    }

    func testDragOutsideEveryFrameSelectsNothing() {
        var selection = PhotoSelection()
        selection.enter()
        selection.selectItems(at: CGPoint(x: 500, y: 500), frames: frames)
        XCTAssertTrue(selection.isEmpty)
    }

    func testDragWithNoKnownFramesIsHarmless() {
        var selection = PhotoSelection()
        selection.enter()
        selection.selectItems(at: CGPoint(x: 50, y: 50), frames: [:])
        XCTAssertTrue(selection.isEmpty)
        XCTAssertTrue(selection.isSelecting)
    }

    // MARK: - Title

    func testTitleCountsTheSelection() {
        var selection = PhotoSelection()
        selection.begin(with: 1)
        XCTAssertEqual(selection.title, "1 ausgewählt")
        selection.toggle(2)
        XCTAssertEqual(selection.title, "2 ausgewählt")
    }
}

/// The order a collage fills its cells in — the order the photos were picked.
final class SelectionOrderTests: XCTestCase {

    func testPhotosKeepTheOrderTheyWereTappedIn() {
        // Tapped 30, then 10, then 20 — not grid order 10, 20, 30.
        var order: [Int] = []
        let grid = [10, 20, 30]
        order = SelectionOrder.reconciled(order, with: [30], gridOrder: grid)
        order = SelectionOrder.reconciled(order, with: [30, 10], gridOrder: grid)
        order = SelectionOrder.reconciled(order, with: [30, 10, 20], gridOrder: grid)
        XCTAssertEqual(order, [30, 10, 20])
    }

    func testDeselectingDropsAPhotoAndTheRestKeepTheirPlace() {
        let order = SelectionOrder.reconciled([30, 10, 20], with: [30, 20], gridOrder: [10, 20, 30])
        XCTAssertEqual(order, [30, 20])
    }

    func testSeveralArrivingAtOnceFollowTheGrid() {
        // A drag or "select all" adds a batch; within it, grid order decides.
        let order = SelectionOrder.reconciled([30], with: [10, 20, 30, 40], gridOrder: [40, 10, 20, 30])
        XCTAssertEqual(order, [30, 40, 10, 20])
    }

    func testAnIdOffTheGridStillCountsAndComesLast() {
        let order = SelectionOrder.reconciled([], with: [7, 3, 5], gridOrder: [5])
        XCTAssertEqual(order, [5, 3, 7])
    }

    func testClearingTheSelectionEmptiesTheOrder() {
        XCTAssertEqual(SelectionOrder.reconciled([1, 2], with: [], gridOrder: [1, 2]), [])
    }
}
