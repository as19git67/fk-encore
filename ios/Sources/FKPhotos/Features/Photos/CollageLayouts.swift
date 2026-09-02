import SwiftUI
import CoreGraphics
import Foundation

/// Splitting a canvas into cells, one per photo — the geometry behind a
/// collage.
///
/// A port of the web's `frontend/src/utils/collageLayouts.ts`, which drives
/// `CollageDialog.vue`, with the same curated table so a collage of the same
/// photos comes out the same shape on both. Two to nine photos, three
/// hand-tuned variants each; cells are normalized inside the canvas, and the
/// canvas's pixel size follows from its aspect at render time.
///
/// There is no collage endpoint: the web renders the result itself and uploads
/// it as an ordinary photo. That upload — and the on-device render it needs —
/// is stage B (#1020); this is the layout half.
enum CollageLayouts {

    // MARK: - Types

    /// One photo's place on the canvas, as fractions of it.
    struct Cell: Equatable, Sendable {
        let x: Double
        let y: Double
        let width: Double
        let height: Double

        /// The cell's own shape, which is what a photo is cropped to.
        var aspect: Double { height > 0 ? width / height : 1 }
    }

    struct Layout: Identifiable, Equatable, Sendable {
        /// Unique within a photo count — the picker's key.
        let id: String
        let name: String
        /// Canvas aspect, width over height.
        let aspect: Double
        /// Exactly as many cells as photos, in fill order.
        let cells: [Cell]
    }

    static let minPhotos = 2
    static let maxPhotos = 9

    /// Whether this many photos can form a collage.
    static func canCollage(_ count: Int) -> Bool {
        (minPhotos...maxPhotos).contains(count)
    }

    // MARK: - Cell builders

    private static let full = Cell(x: 0, y: 0, width: 1, height: 1)

    /// An even `columns × rows` grid, row by row.
    private static func grid(_ columns: Int, _ rows: Int, in region: Cell = full) -> [Cell] {
        let cellWidth = region.width / Double(columns)
        let cellHeight = region.height / Double(rows)
        return (0..<rows).flatMap { row in
            (0..<columns).map { column in
                Cell(
                    x: region.x + Double(column) * cellWidth,
                    y: region.y + Double(row) * cellHeight,
                    width: cellWidth,
                    height: cellHeight
                )
            }
        }
    }

    /// Equal-height rows, row `i` split into `counts[i]` equal-width cells.
    /// Rows of differing widths are what make the asymmetric variants.
    private static func rowBands(_ counts: [Int], in region: Cell = full) -> [Cell] {
        let cellHeight = region.height / Double(counts.count)
        return counts.enumerated().flatMap { row, count -> [Cell] in
            let cellWidth = region.width / Double(count)
            return (0..<count).map { column in
                Cell(
                    x: region.x + Double(column) * cellWidth,
                    y: region.y + Double(row) * cellHeight,
                    width: cellWidth,
                    height: cellHeight
                )
            }
        }
    }

    /// The transpose of `rowBands`: equal-width columns, each split vertically.
    private static func columnBands(_ counts: [Int], in region: Cell = full) -> [Cell] {
        let cellWidth = region.width / Double(counts.count)
        return counts.enumerated().flatMap { column, count -> [Cell] in
            let cellHeight = region.height / Double(count)
            return (0..<count).map { row in
                Cell(
                    x: region.x + Double(column) * cellWidth,
                    y: region.y + Double(row) * cellHeight,
                    width: cellWidth,
                    height: cellHeight
                )
            }
        }
    }

    /// One big cell on the left, the rest banded on the right.
    private static func heroLeft(_ heroWidth: Double, rest: [Int]) -> [Cell] {
        [Cell(x: 0, y: 0, width: heroWidth, height: 1)]
            + rowBands(rest, in: Cell(x: heroWidth, y: 0, width: 1 - heroWidth, height: 1))
    }

    // MARK: - The table

    /// The curated variants, matching the web's table entry for entry — same
    /// ids, names, aspects and cells, so a collage looks the same wherever it
    /// was built.
    private static let table: [Int: [Layout]] = [
        2: [
            Layout(id: "side", name: "Nebeneinander", aspect: 3.0 / 2, cells: rowBands([2])),
            Layout(id: "stack", name: "Übereinander", aspect: 3.0 / 4, cells: columnBands([2])),
            Layout(id: "big-left", name: "Groß + Klein", aspect: 3.0 / 2, cells: [
                Cell(x: 0, y: 0, width: 0.62, height: 1),
                Cell(x: 0.62, y: 0, width: 0.38, height: 1),
            ]),
        ],
        3: [
            Layout(id: "cols", name: "Spalten", aspect: 3.0 / 2, cells: rowBands([3])),
            Layout(id: "hero-left", name: "Held links", aspect: 3.0 / 2, cells: heroLeft(0.6, rest: [1, 1])),
            Layout(id: "hero-top", name: "Held oben", aspect: 1, cells: [
                Cell(x: 0, y: 0, width: 1, height: 0.6),
                Cell(x: 0, y: 0.6, width: 0.5, height: 0.4),
                Cell(x: 0.5, y: 0.6, width: 0.5, height: 0.4),
            ]),
        ],
        4: [
            Layout(id: "grid", name: "Raster 2×2", aspect: 1, cells: grid(2, 2)),
            Layout(id: "cols", name: "Spalten", aspect: 16.0 / 9, cells: rowBands([4])),
            Layout(id: "hero-left", name: "Held links", aspect: 3.0 / 2, cells: heroLeft(0.6, rest: [1, 1, 1])),
        ],
        5: [
            Layout(id: "hero-left", name: "Held links", aspect: 3.0 / 2, cells:
                [Cell(x: 0, y: 0, width: 0.6, height: 1)]
                + grid(2, 2, in: Cell(x: 0.6, y: 0, width: 0.4, height: 1))
            ),
            Layout(id: "two-three", name: "2 / 3", aspect: 3.0 / 2, cells: rowBands([2, 3])),
            Layout(id: "three-two", name: "3 / 2", aspect: 3.0 / 2, cells: rowBands([3, 2])),
        ],
        6: [
            Layout(id: "grid-3x2", name: "Raster 3×2", aspect: 3.0 / 2, cells: grid(3, 2)),
            Layout(id: "grid-2x3", name: "Raster 2×3", aspect: 2.0 / 3, cells: grid(2, 3)),
            Layout(id: "two-four", name: "2 groß / 4", aspect: 3.0 / 2, cells: rowBands([2, 4])),
        ],
        7: [
            Layout(id: "three-four", name: "3 / 4", aspect: 3.0 / 2, cells: rowBands([3, 4])),
            Layout(id: "hero-left", name: "Held links", aspect: 3.0 / 2, cells:
                [Cell(x: 0, y: 0, width: 0.5, height: 1)]
                + grid(2, 3, in: Cell(x: 0.5, y: 0, width: 0.5, height: 1))
            ),
            Layout(id: "four-three", name: "4 / 3", aspect: 3.0 / 2, cells: rowBands([4, 3])),
        ],
        8: [
            Layout(id: "grid-4x2", name: "Raster 4×2", aspect: 16.0 / 9, cells: grid(4, 2)),
            Layout(id: "grid-2x4", name: "Raster 2×4", aspect: 9.0 / 16, cells: grid(2, 4)),
            Layout(id: "three-two-three", name: "3 / 2 / 3", aspect: 1, cells: rowBands([3, 2, 3])),
        ],
        9: [
            Layout(id: "grid-3x3", name: "Raster 3×3", aspect: 1, cells: grid(3, 3)),
            Layout(id: "hero-left", name: "Held links", aspect: 3.0 / 2, cells:
                [Cell(x: 0, y: 0, width: 0.5, height: 1)]
                + grid(2, 4, in: Cell(x: 0.5, y: 0, width: 0.5, height: 1))
            ),
            Layout(id: "two-three-four", name: "2 / 3 / 4", aspect: 3.0 / 2, cells: rowBands([2, 3, 4])),
        ],
    ]

    /// The variants for this many photos, or none when the count is out of
    /// range. Every layout returned has exactly `count` cells.
    static func layouts(for count: Int) -> [Layout] {
        table[count] ?? []
    }

    // MARK: - Cover crop

    /// The part of a photo that fills a cell.
    struct SourceRect: Equatable, Sendable {
        let x: Double
        let y: Double
        let width: Double
        let height: Double
    }

    /// Which part of a photo to draw so it fills a cell of `destinationAspect`
    /// completely, cropping whatever does not fit.
    ///
    /// `focal` is the point that must stay visible — the same `auto_crop`
    /// the thumbnail grid uses to keep faces from being cut off. Absent, the
    /// crop is centred. `zoom` above 1 tightens the window around the focal
    /// point; 1 is a plain fill.
    static func coverCrop(
        photoWidth: Double,
        photoHeight: Double,
        destinationAspect: Double,
        focal: CGPoint? = nil,
        zoom: Double = 1
    ) -> SourceRect {
        guard photoWidth > 0, photoHeight > 0, destinationAspect > 0 else {
            return SourceRect(x: 0, y: 0, width: max(0, photoWidth), height: max(0, photoHeight))
        }
        var width: Double
        var height: Double
        if photoWidth / photoHeight > destinationAspect {
            // Wider than the cell: keep the full height, crop the sides.
            height = photoHeight
            width = photoHeight * destinationAspect
        } else {
            // Taller than the cell: keep the full width, crop top and bottom.
            width = photoWidth
            height = photoWidth / destinationAspect
        }
        let scale = zoom > 0 ? zoom : 1
        width /= scale
        height /= scale

        let focalX = clamped(focal.map { Double($0.x) })
        let focalY = clamped(focal.map { Double($0.y) })
        return SourceRect(
            x: (photoWidth - width) * focalX,
            y: (photoHeight - height) * focalY,
            width: width,
            height: height
        )
    }

    /// A focal coordinate, defaulting to the centre when missing or nonsense.
    private static func clamped(_ value: Double?) -> Double {
        guard let value, value.isFinite else { return 0.5 }
        return min(max(value, 0), 1)
    }

    /// The same focal point as a SwiftUI alignment, for the preview — so what
    /// is on screen and what gets rendered agree.
    ///
    /// SwiftUI's unit points run the same way as the web's `object-position`
    /// percentages, so the value carries over unchanged.
    static func alignment(focal: CGPoint?) -> UnitPoint {
        UnitPoint(
            x: clamped(focal.map { Double($0.x) }),
            y: clamped(focal.map { Double($0.y) })
        )
    }

    // MARK: - Rearranging

    /// Swap two positions in the fill order.
    ///
    /// Out-of-range or identical indices leave the order untouched rather than
    /// trapping — a drag that ends nowhere is a no-op, not a crash.
    static func swap(_ order: [Int], _ i: Int, _ j: Int) -> [Int] {
        guard i != j, order.indices.contains(i), order.indices.contains(j) else {
            return order
        }
        var next = order
        next.swapAt(i, j)
        return next
    }
}
