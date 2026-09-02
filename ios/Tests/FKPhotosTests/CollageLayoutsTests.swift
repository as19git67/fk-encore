import SwiftUI
import XCTest
@testable import FKPhotosLib

/// The collage layout table and the crop that fills each cell.
final class CollageLayoutsTests: XCTestCase {

    // MARK: - Which counts work

    func testTwoToNinePhotosMakeACollage() {
        for count in 2...9 {
            XCTAssertTrue(CollageLayouts.canCollage(count), "\(count) should be allowed")
        }
    }

    func testOnePhotoIsNotACollage() {
        XCTAssertFalse(CollageLayouts.canCollage(0))
        XCTAssertFalse(CollageLayouts.canCollage(1))
    }

    func testTenPhotosAreTooMany() {
        XCTAssertFalse(CollageLayouts.canCollage(10))
        XCTAssertFalse(CollageLayouts.canCollage(100))
    }

    func testAnUnsupportedCountOffersNoLayouts() {
        XCTAssertTrue(CollageLayouts.layouts(for: 1).isEmpty)
        XCTAssertTrue(CollageLayouts.layouts(for: 10).isEmpty)
        XCTAssertTrue(CollageLayouts.layouts(for: -3).isEmpty)
    }

    // MARK: - The table's shape

    func testEveryAllowedCountOffersThreeVariants() {
        for count in CollageLayouts.minPhotos...CollageLayouts.maxPhotos {
            XCTAssertEqual(
                CollageLayouts.layouts(for: count).count, 3,
                "\(count) photos should offer three variants"
            )
        }
    }

    func testEveryLayoutHasExactlyOneCellPerPhoto() {
        // The whole contract: a photo per cell, a cell per photo.
        for count in CollageLayouts.minPhotos...CollageLayouts.maxPhotos {
            for layout in CollageLayouts.layouts(for: count) {
                XCTAssertEqual(
                    layout.cells.count, count,
                    "\(count)/\(layout.id) has \(layout.cells.count) cells"
                )
            }
        }
    }

    func testVariantIdsAreUniqueWithinACount() {
        // The picker keys on the id, so a duplicate would collapse two
        // variants into one row.
        for count in CollageLayouts.minPhotos...CollageLayouts.maxPhotos {
            let ids = CollageLayouts.layouts(for: count).map(\.id)
            XCTAssertEqual(Set(ids).count, ids.count, "duplicate id for \(count) photos")
        }
    }

    func testEveryVariantIsNamed() {
        for count in CollageLayouts.minPhotos...CollageLayouts.maxPhotos {
            for layout in CollageLayouts.layouts(for: count) {
                XCTAssertFalse(layout.name.isEmpty, "\(count)/\(layout.id) has no name")
                XCTAssertGreaterThan(layout.aspect, 0, "\(count)/\(layout.id) has no shape")
            }
        }
    }

    // MARK: - The cells cover the canvas

    func testEveryCellSitsInsideTheCanvas() {
        for count in CollageLayouts.minPhotos...CollageLayouts.maxPhotos {
            for layout in CollageLayouts.layouts(for: count) {
                for (index, cell) in layout.cells.enumerated() {
                    let label = "\(count)/\(layout.id) cell \(index)"
                    XCTAssertGreaterThanOrEqual(cell.x, -0.0001, label)
                    XCTAssertGreaterThanOrEqual(cell.y, -0.0001, label)
                    XCTAssertGreaterThan(cell.width, 0, label)
                    XCTAssertGreaterThan(cell.height, 0, label)
                    XCTAssertLessThanOrEqual(cell.x + cell.width, 1.0001, label)
                    XCTAssertLessThanOrEqual(cell.y + cell.height, 1.0001, label)
                }
            }
        }
    }

    func testTheCellsFillTheCanvasWithNoGapAndNoOverlap() {
        // Areas summing to exactly 1 means the cells tile the canvas: any gap
        // would leave a hole in the collage, any overlap would hide a photo.
        for count in CollageLayouts.minPhotos...CollageLayouts.maxPhotos {
            for layout in CollageLayouts.layouts(for: count) {
                let area = layout.cells.reduce(0) { $0 + $1.width * $1.height }
                XCTAssertEqual(
                    area, 1, accuracy: 0.0001,
                    "\(count)/\(layout.id) covers \(area) of the canvas"
                )
            }
        }
    }

    func testNoTwoCellsOverlap() {
        for count in CollageLayouts.minPhotos...CollageLayouts.maxPhotos {
            for layout in CollageLayouts.layouts(for: count) {
                let cells = layout.cells
                for i in cells.indices {
                    for j in (i + 1)..<cells.count {
                        let a = cells[i], b = cells[j]
                        let overlapX = min(a.x + a.width, b.x + b.width) - max(a.x, b.x)
                        let overlapY = min(a.y + a.height, b.y + b.height) - max(a.y, b.y)
                        XCTAssertTrue(
                            overlapX <= 0.0001 || overlapY <= 0.0001,
                            "\(count)/\(layout.id): cells \(i) and \(j) overlap"
                        )
                    }
                }
            }
        }
    }

    // MARK: - Individual layouts

    func testTwoSideBySideSplitsTheCanvasInHalf() throws {
        let layout = try XCTUnwrap(
            CollageLayouts.layouts(for: 2).first { $0.id == "side" }
        )
        XCTAssertEqual(layout.cells[0].width, 0.5, accuracy: 0.0001)
        XCTAssertEqual(layout.cells[1].x, 0.5, accuracy: 0.0001)
        XCTAssertEqual(layout.cells[0].height, 1, accuracy: 0.0001)
    }

    func testStackedTwoIsPortrait() throws {
        let layout = try XCTUnwrap(
            CollageLayouts.layouts(for: 2).first { $0.id == "stack" }
        )
        XCTAssertLessThan(layout.aspect, 1, "stacked photos want a tall canvas")
        XCTAssertEqual(layout.cells[1].y, 0.5, accuracy: 0.0001)
    }

    func testAThreeByThreeGridIsFilledRowByRow() throws {
        let layout = try XCTUnwrap(
            CollageLayouts.layouts(for: 9).first { $0.id == "grid-3x3" }
        )
        // Cell 3 starts the second row: back to the left, one row down.
        XCTAssertEqual(layout.cells[3].x, 0, accuracy: 0.0001)
        XCTAssertEqual(layout.cells[3].y, 1.0 / 3, accuracy: 0.0001)
        XCTAssertEqual(layout.cells[8].x, 2.0 / 3, accuracy: 0.0001)
    }

    func testAHeroLayoutLeadsWithItsBigCell() throws {
        let layout = try XCTUnwrap(
            CollageLayouts.layouts(for: 3).first { $0.id == "hero-left" }
        )
        let hero = layout.cells[0]
        XCTAssertEqual(hero.x, 0, accuracy: 0.0001)
        XCTAssertEqual(hero.height, 1, accuracy: 0.0001)
        for other in layout.cells.dropFirst() {
            XCTAssertGreaterThan(
                hero.width * hero.height, other.width * other.height,
                "the hero should be the largest cell"
            )
        }
    }

    func testAsymmetricBandsHaveDifferentlyWideCells() throws {
        // "2 / 3": two wide cells on top, three narrower below.
        let layout = try XCTUnwrap(
            CollageLayouts.layouts(for: 5).first { $0.id == "two-three" }
        )
        XCTAssertEqual(layout.cells[0].width, 0.5, accuracy: 0.0001)
        XCTAssertEqual(layout.cells[2].width, 1.0 / 3, accuracy: 0.0001)
        XCTAssertEqual(layout.cells[2].y, 0.5, accuracy: 0.0001)
    }

    // MARK: - Cover crop

    func testAWidePhotoInASquareCellLosesItsSides() {
        let rect = CollageLayouts.coverCrop(
            photoWidth: 4000, photoHeight: 2000, destinationAspect: 1
        )
        XCTAssertEqual(rect.height, 2000, accuracy: 0.001, "full height kept")
        XCTAssertEqual(rect.width, 2000, accuracy: 0.001, "cropped to a square")
    }

    func testATallPhotoInAWideCellLosesItsTopAndBottom() {
        let rect = CollageLayouts.coverCrop(
            photoWidth: 2000, photoHeight: 4000, destinationAspect: 2
        )
        XCTAssertEqual(rect.width, 2000, accuracy: 0.001, "full width kept")
        XCTAssertEqual(rect.height, 1000, accuracy: 0.001)
    }

    func testAMatchingPhotoIsNotCropped() {
        let rect = CollageLayouts.coverCrop(
            photoWidth: 3000, photoHeight: 2000, destinationAspect: 1.5
        )
        XCTAssertEqual(rect.width, 3000, accuracy: 0.001)
        XCTAssertEqual(rect.height, 2000, accuracy: 0.001)
        XCTAssertEqual(rect.x, 0, accuracy: 0.001)
        XCTAssertEqual(rect.y, 0, accuracy: 0.001)
    }

    func testWithoutAFocalPointTheCropIsCentred() {
        let rect = CollageLayouts.coverCrop(
            photoWidth: 4000, photoHeight: 2000, destinationAspect: 1
        )
        XCTAssertEqual(rect.x, 1000, accuracy: 0.001, "(4000 - 2000) / 2")
    }

    func testAFocalPointPullsTheCropTowardsIt() {
        // A face at the far left must not be cropped away.
        let left = CollageLayouts.coverCrop(
            photoWidth: 4000, photoHeight: 2000, destinationAspect: 1,
            focal: CGPoint(x: 0, y: 0.5)
        )
        XCTAssertEqual(left.x, 0, accuracy: 0.001)

        let right = CollageLayouts.coverCrop(
            photoWidth: 4000, photoHeight: 2000, destinationAspect: 1,
            focal: CGPoint(x: 1, y: 0.5)
        )
        XCTAssertEqual(right.x, 2000, accuracy: 0.001)
    }

    func testAFocalPointOutsideThePhotoIsPulledBackIn() {
        let rect = CollageLayouts.coverCrop(
            photoWidth: 4000, photoHeight: 2000, destinationAspect: 1,
            focal: CGPoint(x: 5, y: -3)
        )
        XCTAssertEqual(rect.x, 2000, accuracy: 0.001, "clamped to the right edge")
        XCTAssertEqual(rect.y, 0, accuracy: 0.001, "clamped to the top")
    }

    func testANonsenseFocalPointFallsBackToTheCentre() {
        let rect = CollageLayouts.coverCrop(
            photoWidth: 4000, photoHeight: 2000, destinationAspect: 1,
            // Spelled out: `CGPoint` takes CGFloat, Double and Int, so a bare
            // `.nan` has nothing to resolve against.
            focal: CGPoint(x: CGFloat.nan, y: CGFloat.nan)
        )
        XCTAssertEqual(rect.x, 1000, accuracy: 0.001)
    }

    func testZoomingTightensTheWindow() {
        let plain = CollageLayouts.coverCrop(
            photoWidth: 4000, photoHeight: 2000, destinationAspect: 1
        )
        let zoomed = CollageLayouts.coverCrop(
            photoWidth: 4000, photoHeight: 2000, destinationAspect: 1, zoom: 2
        )
        XCTAssertEqual(zoomed.width, plain.width / 2, accuracy: 0.001)
        XCTAssertEqual(zoomed.height, plain.height / 2, accuracy: 0.001)
    }

    func testAZeroZoomIsTreatedAsNone() {
        let plain = CollageLayouts.coverCrop(
            photoWidth: 4000, photoHeight: 2000, destinationAspect: 1
        )
        let zero = CollageLayouts.coverCrop(
            photoWidth: 4000, photoHeight: 2000, destinationAspect: 1, zoom: 0
        )
        XCTAssertEqual(zero.width, plain.width, accuracy: 0.001)
    }

    func testAPhotoWithNoSizeYieldsAnEmptyCrop() {
        let rect = CollageLayouts.coverCrop(
            photoWidth: 0, photoHeight: 0, destinationAspect: 1
        )
        XCTAssertEqual(rect.width, 0, accuracy: 0.001)
        XCTAssertEqual(rect.height, 0, accuracy: 0.001)
    }

    // MARK: - Preview alignment

    func testTheAlignmentMirrorsTheCrop() {
        XCTAssertEqual(CollageLayouts.alignment(focal: CGPoint(x: 0.25, y: 0.75)),
                       UnitPoint(x: 0.25, y: 0.75))
        XCTAssertEqual(CollageLayouts.alignment(focal: nil), UnitPoint(x: 0.5, y: 0.5))
        XCTAssertEqual(CollageLayouts.alignment(focal: CGPoint(x: -1, y: 2)),
                       UnitPoint(x: 0, y: 1))
    }

    // MARK: - Rearranging

    func testSwappingTwoPositionsExchangesThem() {
        XCTAssertEqual(CollageLayouts.swap([0, 1, 2, 3], 0, 3), [3, 1, 2, 0])
    }

    func testSwappingAPositionWithItselfChangesNothing() {
        XCTAssertEqual(CollageLayouts.swap([0, 1, 2], 1, 1), [0, 1, 2])
    }

    func testADragThatEndsNowhereIsANoOp() {
        // Out of range must not trap — a drag off the edge is not a crash.
        XCTAssertEqual(CollageLayouts.swap([0, 1, 2], 0, 9), [0, 1, 2])
        XCTAssertEqual(CollageLayouts.swap([0, 1, 2], -1, 1), [0, 1, 2])
        XCTAssertEqual(CollageLayouts.swap([Int](), 0, 1), [Int]())
    }

    func testSwappingLeavesTheOriginalUntouched() {
        let order = [0, 1, 2]
        _ = CollageLayouts.swap(order, 0, 2)
        XCTAssertEqual(order, [0, 1, 2])
    }
}
