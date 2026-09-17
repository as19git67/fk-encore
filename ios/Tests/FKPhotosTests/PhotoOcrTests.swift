import XCTest
@testable import FKPhotosLib

/// Where a recognised line sits on the photo — mirrored case for case from
/// the web's `ocrLayout.test.ts`, because a word that the web and the app put
/// in different places is a bug in one of them.
final class PhotoOcrTests: XCTestCase {

    private func block(
        text: String = "Hauptbahnhof",
        confidence: Double = 0.9,
        polygon: [PhotoOcrPoint]? = nil,
        left: Double = 0.1, top: Double = 0.2, right: Double = 0.5, bottom: Double = 0.3
    ) -> PhotoOcrBlock {
        PhotoOcrBlock(
            text: text,
            confidence: confidence,
            polygon: polygon ?? [
                PhotoOcrPoint(x: 0.1, y: 0.2), PhotoOcrPoint(x: 0.5, y: 0.2),
                PhotoOcrPoint(x: 0.5, y: 0.3), PhotoOcrPoint(x: 0.1, y: 0.3),
            ],
            left: left, top: top, right: right, bottom: bottom
        )
    }

    // MARK: - Wire format

    func testTheServersAnswerDecodesWithItsOwnKeys() throws {
        let json = """
        {"ocr":{"photo_id":7,"blocks":[{"text":"Gleis 3","confidence":0.91,
        "polygon":[{"x":0.1,"y":0.2},{"x":0.5,"y":0.2},{"x":0.5,"y":0.3},{"x":0.1,"y":0.3}],
        "left":0.1,"top":0.2,"right":0.5,"bottom":0.3}],
        "full_text":"Gleis 3","mean_confidence":0.91,"scanned_at":"2026-09-16T10:00:00Z"}}
        """
        let decoded = try JSONDecoder().decode(PhotoOcrResponse.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.ocr?.photo_id, 7)
        XCTAssertEqual(decoded.ocr?.blocks.first?.text, "Gleis 3")
        XCTAssertEqual(decoded.ocr?.blocks.first?.polygon.count, 4)
    }

    func testNotScannedYetIsNilRatherThanEmpty() throws {
        let decoded = try JSONDecoder().decode(PhotoOcrResponse.self, from: Data(#"{"ocr":null}"#.utf8))
        XCTAssertNil(decoded.ocr)
    }

    // MARK: - Angle

    func testALevelLineHasNoAngle() {
        XCTAssertEqual(PhotoOcrLayout.angle(of: block().polygon), 0)
    }

    func testTheAngleFollowsTheTopEdge() {
        // Rises to the right by as much as it runs: 45° upwards on screen.
        let angle = PhotoOcrLayout.angle(of: [PhotoOcrPoint(x: 0, y: 0.5), PhotoOcrPoint(x: 0.5, y: 0)])
        XCTAssertEqual(angle, -.pi / 4, accuracy: 1e-9)
    }

    func testADegeneratePolygonCountsAsLevel() {
        XCTAssertEqual(PhotoOcrLayout.angle(of: []), 0)
        XCTAssertEqual(PhotoOcrLayout.angle(of: [PhotoOcrPoint(x: 0.2, y: 0.2)]), 0)
        XCTAssertEqual(PhotoOcrLayout.angle(of: [PhotoOcrPoint(x: 0.2, y: 0.2), PhotoOcrPoint(x: 0.2, y: 0.2)]), 0)
    }

    // MARK: - Layout

    func testALevelLineIsLaidIntoItsBox() {
        let line = PhotoOcrLayout.layout(block())
        XCTAssertEqual(line.x, 0.1)
        XCTAssertEqual(line.y, 0.2)
        XCTAssertEqual(line.width, 0.4, accuracy: 1e-9)
        XCTAssertEqual(line.height, 0.1, accuracy: 1e-9)
        XCTAssertEqual(line.angle, 0)
    }

    func testATiltedLineIsAnchoredAtItsFirstCornerWithTheQuadsOwnSize() {
        let tilted = block(polygon: [
            PhotoOcrPoint(x: 0.1, y: 0.4), PhotoOcrPoint(x: 0.4, y: 0.1),
            PhotoOcrPoint(x: 0.45, y: 0.15), PhotoOcrPoint(x: 0.15, y: 0.45),
        ])
        let line = PhotoOcrLayout.layout(tilted)
        XCTAssertEqual(line.x, 0.1)
        XCTAssertEqual(line.y, 0.4)
        XCTAssertEqual(line.width, hypot(0.3, 0.3), accuracy: 1e-9)
        XCTAssertEqual(line.height, hypot(0.05, 0.05), accuracy: 1e-9)
        XCTAssertEqual(line.angle, -.pi / 4, accuracy: 1e-9)
    }

    func testWithoutAUsableQuadTheBoundingBoxIsUsed() {
        let line = PhotoOcrLayout.layout(block(polygon: []))
        XCTAssertEqual(line.x, 0.1)
        XCTAssertEqual(line.width, 0.4, accuracy: 1e-9)
        XCTAssertEqual(line.angle, 0)
    }

    func testAQuadWithoutAreaFallsBackToo() {
        let p = PhotoOcrPoint(x: 0.1, y: 0.2)
        let flat = block(polygon: [p, p, p, p])
        XCTAssertEqual(PhotoOcrLayout.layout(flat).angle, 0)
        XCTAssertEqual(PhotoOcrLayout.layout(flat).width, 0.4, accuracy: 1e-9)
    }

    // MARK: - Fit

    func testMeasuredTextIsStretchedToTheBox() {
        XCTAssertEqual(PhotoOcrLayout.fitScaleX(measuredWidth: 50, targetWidth: 100), 2)
        XCTAssertEqual(PhotoOcrLayout.fitScaleX(measuredWidth: 200, targetWidth: 100), 0.5)
    }

    func testNothingSensibleMeasuredLeavesTheTextAlone() {
        XCTAssertEqual(PhotoOcrLayout.fitScaleX(measuredWidth: 0, targetWidth: 100), 1)
        XCTAssertEqual(PhotoOcrLayout.fitScaleX(measuredWidth: .nan, targetWidth: 100), 1)
        XCTAssertEqual(PhotoOcrLayout.fitScaleX(measuredWidth: 50, targetWidth: 0), 1)
    }

    func testAnAbsurdRatioIsClamped() {
        XCTAssertEqual(PhotoOcrLayout.fitScaleX(measuredWidth: 1, targetWidth: 1000), 8)
        XCTAssertEqual(PhotoOcrLayout.fitScaleX(measuredWidth: 1000, targetWidth: 1), 0.125)
    }

    // MARK: - Crop

    private let crop = PhotoTransforms.Crop(x: 0.25, y: 0.25, w: 0.5, h: 0.5)

    func testAPointIsRebasedOntoTheCrop() {
        XCTAssertEqual(PhotoOcrLayout.map(PhotoOcrPoint(x: 0.25, y: 0.25), intoCrop: crop), PhotoOcrPoint(x: 0, y: 0))
        XCTAssertEqual(PhotoOcrLayout.map(PhotoOcrPoint(x: 0.5, y: 0.5), intoCrop: crop), PhotoOcrPoint(x: 0.5, y: 0.5))
        XCTAssertEqual(PhotoOcrLayout.map(PhotoOcrPoint(x: 0.75, y: 0.75), intoCrop: crop), PhotoOcrPoint(x: 1, y: 1))
    }

    func testAPointTheCropCutOffLandsOutsideTheSquare() {
        XCTAssertLessThan(PhotoOcrLayout.map(PhotoOcrPoint(x: 0.1, y: 0.1), intoCrop: crop).x, 0)
        XCTAssertGreaterThan(PhotoOcrLayout.map(PhotoOcrPoint(x: 0.9, y: 0.9), intoCrop: crop).y, 1)
    }

    func testADegenerateCropLeavesThePointAlone() {
        let p = PhotoOcrPoint(x: 0.3, y: 0.3)
        XCTAssertEqual(PhotoOcrLayout.map(p, intoCrop: PhotoTransforms.Crop(x: 0, y: 0, w: 0, h: 0)), p)
    }

    func testAWholeBlockIsMappedCornersAndBoxAlike() {
        let b = block(
            polygon: [
                PhotoOcrPoint(x: 0.3, y: 0.3), PhotoOcrPoint(x: 0.5, y: 0.3),
                PhotoOcrPoint(x: 0.5, y: 0.35), PhotoOcrPoint(x: 0.3, y: 0.35),
            ],
            left: 0.3, top: 0.3, right: 0.5, bottom: 0.35
        )
        let m = PhotoOcrLayout.map(b, into: .init(crop: crop))
        XCTAssertEqual(m.polygon[0].x, 0.1, accuracy: 1e-9)
        XCTAssertEqual(m.polygon[0].y, 0.1, accuracy: 1e-9)
        XCTAssertEqual(m.polygon[1].x, 0.5, accuracy: 1e-9)
        XCTAssertEqual(m.left, 0.1, accuracy: 1e-9)
        XCTAssertEqual(m.right, 0.5, accuracy: 1e-9)
        XCTAssertEqual(m.bottom, 0.2, accuracy: 1e-9)
        XCTAssertEqual(m.text, b.text)
    }

    func testATiltedLineKeepsItsTiltAfterCropping() {
        let tilted = block(polygon: [
            PhotoOcrPoint(x: 0.3, y: 0.6), PhotoOcrPoint(x: 0.6, y: 0.3),
            PhotoOcrPoint(x: 0.65, y: 0.35), PhotoOcrPoint(x: 0.35, y: 0.65),
        ])
        let line = PhotoOcrLayout.layout(PhotoOcrLayout.map(tilted, into: .init(crop: crop)))
        XCTAssertEqual(line.angle, -.pi / 4, accuracy: 1e-9)
    }

    // MARK: - Visibility

    func testALineInsideTheViewIsKept() {
        XCTAssertTrue(PhotoOcrLayout.isVisible(.init(text: "", confidence: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.05, angle: 0)))
    }

    func testALineStraddlingTheEdgeIsKept() {
        XCTAssertTrue(PhotoOcrLayout.isVisible(.init(text: "", confidence: 1, x: -0.1, y: 0.1, width: 0.2, height: 0.05, angle: 0)))
        XCTAssertTrue(PhotoOcrLayout.isVisible(.init(text: "", confidence: 1, x: 0.95, y: 0.1, width: 0.2, height: 0.05, angle: 0)))
    }

    func testALineTheCropCutOffEntirelyIsDropped() {
        XCTAssertFalse(PhotoOcrLayout.isVisible(.init(text: "", confidence: 1, x: -0.5, y: 0.1, width: 0.2, height: 0.05, angle: 0)))
        XCTAssertFalse(PhotoOcrLayout.isVisible(.init(text: "", confidence: 1, x: 1.2, y: 0.1, width: 0.2, height: 0.05, angle: 0)))
        XCTAssertFalse(PhotoOcrLayout.isVisible(.init(text: "", confidence: 1, x: 0.1, y: 1.5, width: 0.2, height: 0.05, angle: 0)))
    }

    // MARK: - Rotation

    func testWhateverTheServerStoredBecomesAQuarterTurn() {
        XCTAssertEqual(PhotoOcrLayout.quarterTurn(0), 0)
        XCTAssertEqual(PhotoOcrLayout.quarterTurn(90), 90)
        XCTAssertEqual(PhotoOcrLayout.quarterTurn(270), 270)
        XCTAssertEqual(PhotoOcrLayout.quarterTurn(360), 0)
        XCTAssertEqual(PhotoOcrLayout.quarterTurn(-90), 270)
    }

    func testTheTopLeftCornerTurnsClockwiseAroundTheSquare() {
        let tl = PhotoOcrPoint(x: 0, y: 0)
        XCTAssertEqual(PhotoOcrLayout.rotate(tl, by: 90), PhotoOcrPoint(x: 1, y: 0))
        XCTAssertEqual(PhotoOcrLayout.rotate(tl, by: 180), PhotoOcrPoint(x: 1, y: 1))
        XCTAssertEqual(PhotoOcrLayout.rotate(tl, by: 270), PhotoOcrPoint(x: 0, y: 1))
        XCTAssertEqual(PhotoOcrLayout.rotate(tl, by: 0), tl)
    }

    func testTheCentreStaysPut() {
        let c = PhotoOcrPoint(x: 0.5, y: 0.5)
        for r in [90, 180, 270] {
            XCTAssertEqual(PhotoOcrLayout.rotate(c, by: r), c)
        }
    }

    func testFourQuarterTurnsAreTheIdentity() {
        let p = PhotoOcrPoint(x: 0.2, y: 0.7)
        var q = p
        for _ in 0..<4 { q = PhotoOcrLayout.rotate(q, by: 90) }
        XCTAssertEqual(q.x, p.x, accuracy: 1e-9)
        XCTAssertEqual(q.y, p.y, accuracy: 1e-9)
    }

    func testWithoutARecipeTheViewIsTheIdentity() {
        let b = block()
        XCTAssertEqual(PhotoOcrLayout.map(b, into: .init()), b)
        XCTAssertEqual(PhotoOcrLayout.map(b, into: .init(crop: nil, rotation: 0)), b)
    }

    func testALevelLineTurnsVerticalUnderNinetyDegrees() {
        let turned = PhotoOcrLayout.map(block(), into: .init(rotation: 90))
        // A line that ran left→right along y=0.2 now runs top→bottom along x=0.8.
        XCTAssertEqual(PhotoOcrLayout.layout(turned).angle, .pi / 2, accuracy: 1e-9)
        XCTAssertEqual(turned.left, 0.7, accuracy: 1e-9)
        XCTAssertEqual(turned.right, 0.8, accuracy: 1e-9)
        XCTAssertEqual(turned.top, 0.1, accuracy: 1e-9)
        XCTAssertEqual(turned.bottom, 0.5, accuracy: 1e-9)
    }

    func testItReadsUpsideDownUnderAHalfTurn() {
        let turned = PhotoOcrLayout.map(block(), into: .init(rotation: 180))
        XCTAssertEqual(abs(PhotoOcrLayout.layout(turned).angle), .pi, accuracy: 1e-9)
        XCTAssertEqual(turned.left, 0.5, accuracy: 1e-9)
        XCTAssertEqual(turned.right, 0.9, accuracy: 1e-9)
    }

    func testItCropsFirstAndTurnsSecondLikeTheServer() {
        // Crop the right half, then turn it. The line at x 0.1–0.5 of the
        // original lies entirely in the left half, so it is off the crop —
        // and after the turn it still has to be off the view, not back in it.
        let rightHalf = PhotoTransforms.Crop(x: 0.5, y: 0, w: 0.5, h: 1)
        let gone = PhotoOcrLayout.lines([block()], view: .init(crop: rightHalf, rotation: 90))
        XCTAssertTrue(gone.isEmpty)

        let inside = block(
            polygon: [
                PhotoOcrPoint(x: 0.6, y: 0.2), PhotoOcrPoint(x: 0.9, y: 0.2),
                PhotoOcrPoint(x: 0.9, y: 0.3), PhotoOcrPoint(x: 0.6, y: 0.3),
            ],
            left: 0.6, top: 0.2, right: 0.9, bottom: 0.3
        )
        let mapped = PhotoOcrLayout.map(inside, into: .init(crop: rightHalf, rotation: 90))
        XCTAssertTrue(PhotoOcrLayout.isVisible(PhotoOcrLayout.layout(mapped)))
        XCTAssertEqual(mapped.polygon[0].x, 0.8, accuracy: 1e-9)
        XCTAssertEqual(mapped.polygon[0].y, 0.2, accuracy: 1e-9)
    }

    // MARK: - Pipeline

    func testThePipelineDropsWhatCannotBeSeen() {
        let offCrop = block(
            polygon: [
                PhotoOcrPoint(x: 0.0, y: 0.0), PhotoOcrPoint(x: 0.1, y: 0.0),
                PhotoOcrPoint(x: 0.1, y: 0.05), PhotoOcrPoint(x: 0.0, y: 0.05),
            ],
            left: 0, top: 0, right: 0.1, bottom: 0.05
        )
        let lines = PhotoOcrLayout.lines([block(), offCrop], view: .init(crop: crop))
        XCTAssertEqual(lines.map(\.text), ["Hauptbahnhof"])
    }

    func testCopyAllKeepsTheReadingOrder() {
        XCTAssertEqual(
            PhotoOcrLayout.fullText([block(text: "Gleis 3"), block(text: "nach Musterstadt")]),
            "Gleis 3\nnach Musterstadt"
        )
        XCTAssertEqual(PhotoOcrLayout.fullText([]), "")
    }
}
