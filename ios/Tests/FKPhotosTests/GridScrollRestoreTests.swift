import XCTest
@testable import FKPhotosLib

/// Coming back to a grid where the viewer left off.
///
/// The index comes from the fullscreen viewer, which may have been
/// paged and may have had photos deleted out from under it — so the
/// only interesting part is what happens when it no longer fits the
/// list it is being applied to.
final class GridScrollRestoreTests: XCTestCase {

    private struct Item: Identifiable {
        let id: Int
    }

    private let items = [Item(id: 10), Item(id: 20), Item(id: 30)]

    func testTheItemTheViewerEndedOn() {
        XCTAssertEqual(GridScroll.target(index: 0, in: items), 10)
        XCTAssertEqual(GridScroll.target(index: 1, in: items), 20)
        XCTAssertEqual(GridScroll.target(index: 2, in: items), 30)
    }

    func testAnIndexPastTheEndIsTheLastItem() {
        // Deleting from inside the viewer shortens the list under it, so
        // the index it last reported can point past the end.
        XCTAssertEqual(GridScroll.target(index: 3, in: items), 30)
        XCTAssertEqual(GridScroll.target(index: 99, in: items), 30)
    }

    func testANegativeIndexIsTheFirstItem() {
        XCTAssertEqual(GridScroll.target(index: -1, in: items), 10)
    }

    func testAnEmptyGridHasNothingToComeBackTo() {
        XCTAssertNil(GridScroll.target(index: 0, in: [Item]()))
        XCTAssertNil(GridScroll.target(index: 5, in: [Item]()))
    }

    func testTheDelayOutlastsThePopAnimation() {
        // A scrollTo issued into a view still sliding in lands nowhere.
        XCTAssertGreaterThanOrEqual(GridScroll.settleDelay, .milliseconds(300))
    }
}
