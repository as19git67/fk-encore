import CoreGraphics
import XCTest
@testable import FKPhotosLib

/// The pixel geometry of a rendered collage, and the metadata it is uploaded
/// with. The drawing itself needs a graphics context; everything decided
/// before that is here.
final class CollageRendererTests: XCTestCase {

    // MARK: - Canvas size

    func testALandscapeCanvasIsAsWideAsItIsAllowed() {
        let size = CollageRenderer.canvasSize(aspect: 3.0 / 2, maxEdge: 2400)
        XCTAssertEqual(Double(size.width), 2400, accuracy: 1)
        XCTAssertEqual(Double(size.height), 1600, accuracy: 1)
    }

    func testAPortraitCanvasIsAsTallAsItIsAllowed() {
        let size = CollageRenderer.canvasSize(aspect: 2.0 / 3, maxEdge: 2400)
        XCTAssertEqual(Double(size.height), 2400, accuracy: 1)
        XCTAssertEqual(Double(size.width), 1600, accuracy: 1)
    }

    func testASquareCanvasIsSquare() {
        let size = CollageRenderer.canvasSize(aspect: 1, maxEdge: 2400)
        XCTAssertEqual(Double(size.width), 2400, accuracy: 1)
        XCTAssertEqual(Double(size.height), 2400, accuracy: 1)
    }

    func testTheLongEdgeNeverExceedsTheLimit() {
        // Whatever the shape, the memory cost stays bounded.
        for aspect in [0.1, 0.5, 1.0, 2.0, 16.0 / 9, 9.0 / 16, 10.0] {
            let size = CollageRenderer.canvasSize(aspect: aspect, maxEdge: 2400)
            XCTAssertLessThanOrEqual(max(Double(size.width), Double(size.height)), 2401, "aspect \(aspect)")
        }
    }

    func testEveryLayoutGetsADrawableCanvas() {
        for count in CollageLayouts.minPhotos...CollageLayouts.maxPhotos {
            for layout in CollageLayouts.layouts(for: count) {
                let size = CollageRenderer.canvasSize(aspect: layout.aspect)
                XCTAssertGreaterThan(Double(size.width), 1, "\(count)/\(layout.id)")
                XCTAssertGreaterThan(Double(size.height), 1, "\(count)/\(layout.id)")
            }
        }
    }

    func testADegenerateAspectStillYieldsSomethingToDrawInto() {
        for aspect in [0.0, -1.0, Double.nan, Double.infinity] {
            let size = CollageRenderer.canvasSize(aspect: aspect, maxEdge: 2400)
            XCTAssertGreaterThanOrEqual(Double(size.width), 1, "aspect \(aspect)")
            XCTAssertGreaterThanOrEqual(Double(size.height), 1, "aspect \(aspect)")
        }
    }

    // MARK: - Cell rectangles

    func testACellCoversItsFractionOfTheCanvas() {
        let canvas = CGSize(width: 1200, height: 800)
        let rect = CollageRenderer.destinationRect(
            for: CollageLayouts.Cell(x: 0, y: 0, width: 0.5, height: 1),
            canvas: canvas
        )
        XCTAssertEqual(Double(rect.minX), 0, accuracy: 0.001)
        XCTAssertEqual(Double(rect.width), 600, accuracy: 1)
        XCTAssertEqual(Double(rect.height), 800, accuracy: 1)
    }

    func testCellsAreWholePixels() {
        // A third of a canvas is not a whole number of pixels; the rect still
        // has to be one.
        let canvas = CGSize(width: 1000, height: 1000)
        let rect = CollageRenderer.destinationRect(
            for: CollageLayouts.Cell(x: 1.0 / 3, y: 0, width: 1.0 / 3, height: 1),
            canvas: canvas
        )
        for value in [rect.minX, rect.minY, rect.width, rect.height] {
            XCTAssertEqual(Double(value), Double(value).rounded(), accuracy: 0.0001)
        }
    }

    func testNeighbouringCellsLeaveNoHairlineBetweenThem() {
        // Rounding each edge inward would leave a sliver of background showing
        // between cells. The rects are grown instead, so they meet or overlap.
        let canvas = CGSize(width: 1000, height: 1000)
        let cells = CollageLayouts.layouts(for: 9)
            .first { $0.id == "grid-3x3" }!
            .cells
        let rects = cells.map { CollageRenderer.destinationRect(for: $0, canvas: canvas) }
        // Row 0: cell 0 ends where cell 1 begins, or a touch past it.
        XCTAssertGreaterThanOrEqual(Double(rects[0].maxX), Double(rects[1].minX))
        XCTAssertGreaterThanOrEqual(Double(rects[1].maxX), Double(rects[2].minX))
        // And the last column still reaches the edge.
        XCTAssertEqual(Double(rects[2].maxX), 1000, accuracy: 1)
    }

    func testTheCellsTogetherCoverTheWholeCanvas() {
        let canvas = CGSize(width: 1200, height: 800)
        for count in CollageLayouts.minPhotos...CollageLayouts.maxPhotos {
            for layout in CollageLayouts.layouts(for: count) {
                let rects = layout.cells.map {
                    CollageRenderer.destinationRect(for: $0, canvas: canvas)
                }
                let union = rects.dropFirst().reduce(rects[0]) { $0.union($1) }
                XCTAssertEqual(Double(union.minX), 0, accuracy: 1, "\(count)/\(layout.id)")
                XCTAssertEqual(Double(union.minY), 0, accuracy: 1, "\(count)/\(layout.id)")
                XCTAssertEqual(Double(union.maxX), 1200, accuracy: 1, "\(count)/\(layout.id)")
                XCTAssertEqual(Double(union.maxY), 800, accuracy: 1, "\(count)/\(layout.id)")
            }
        }
    }

    // MARK: - Inherited date

    private func photo(id: Int, takenAt: String?) -> PhotoWithCuration {
        PhotoWithCuration(
            id: id,
            user_id: 1,
            filename: "photo-\(id).jpg",
            original_name: "photo-\(id).jpg",
            mime_type: "image/jpeg",
            size: 0,
            hash: nil,
            taken_at: takenAt,
            created_at: "2024-06-01T12:00:00.000Z",
            latitude: nil,
            longitude: nil,
            location_name: nil,
            location_city: nil,
            location_country: nil,
            ai_quality_score: nil,
            ai_quality_details: nil,
            auto_crop: nil,
            curation_status: .visible,
            description: nil,
            keywords: nil
        )
    }

    func testACollageTakesTheDateOfItsOldestSource() {
        // Otherwise it sorts at "now", away from the photos it is made of.
        let photos = [
            photo(id: 1, takenAt: "2024-06-15T10:00:00.000Z"),
            photo(id: 2, takenAt: "2024-06-01T10:00:00.000Z"),
            photo(id: 3, takenAt: "2024-06-30T10:00:00.000Z"),
        ]
        XCTAssertEqual(
            CollageRenderer.inheritedDate(from: photos),
            "2024-06-01T10:00:00.000Z"
        )
    }

    func testSourcesWithoutADateAreSkipped() {
        let photos = [
            photo(id: 1, takenAt: nil),
            photo(id: 2, takenAt: "2024-06-05T10:00:00.000Z"),
        ]
        XCTAssertEqual(
            CollageRenderer.inheritedDate(from: photos),
            "2024-06-05T10:00:00.000Z"
        )
    }

    func testNoDatedSourceMeansNothingToInherit() {
        // The server then falls back to the rendered file's own EXIF.
        XCTAssertNil(CollageRenderer.inheritedDate(from: [photo(id: 1, takenAt: nil)]))
        XCTAssertNil(CollageRenderer.inheritedDate(from: []))
    }

    func testAnUnparseableDateDoesNotWinByAccident() {
        let photos = [
            photo(id: 1, takenAt: "irgendwann"),
            photo(id: 2, takenAt: "2024-06-05T10:00:00.000Z"),
        ]
        XCTAssertEqual(
            CollageRenderer.inheritedDate(from: photos),
            "2024-06-05T10:00:00.000Z"
        )
    }

    func testTheDateIsPassedOnExactlyAsItArrived() {
        // The server parses it; re-formatting here could only lose fidelity.
        let raw = "2024-06-05 10:00:00.123456"
        XCTAssertEqual(
            CollageRenderer.inheritedDate(from: [photo(id: 1, takenAt: raw)]),
            raw
        )
    }

    // MARK: - Filename

    func testTheFilenameSaysWhatItIsAndWhen() {
        var components = DateComponents()
        components.year = 2024
        components.month = 6
        components.day = 5
        components.hour = 14
        components.minute = 30
        components.second = 15
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone.current
        let date = calendar.date(from: components)!

        let name = CollageRenderer.filename(date: date)
        XCTAssertEqual(name, "collage-20240605-143015.jpg")
    }

    func testTwoCollagesASecondApartDoNotShareAName() {
        let first = CollageRenderer.filename(date: Date(timeIntervalSince1970: 1_000_000))
        let second = CollageRenderer.filename(date: Date(timeIntervalSince1970: 1_000_001))
        XCTAssertNotEqual(first, second)
    }
}
