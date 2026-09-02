import CoreGraphics
import XCTest
@testable import FKPhotosLib

/// Measuring how sharp a face is: the traffic light, the crop, and the
/// Laplacian behind both.
final class FocusPeakingTests: XCTestCase {

    // MARK: - Classification

    func testAHighScoreIsSharp() {
        XCTAssertEqual(FocusPeaking.classify(0.9), .sharp)
        XCTAssertEqual(FocusPeaking.classify(FocusPeaking.sharpMin), .sharp)
    }

    func testAMiddlingScoreIsMedium() {
        XCTAssertEqual(FocusPeaking.classify(0.3), .medium)
        XCTAssertEqual(FocusPeaking.classify(FocusPeaking.mediumMin), .medium)
    }

    func testALowScoreIsUnsharp() {
        XCTAssertEqual(FocusPeaking.classify(0.05), .unsharp)
        XCTAssertEqual(FocusPeaking.classify(0), .unsharp)
    }

    func testAnUnmeasurableScoreIsNotTreatedAsSharp() {
        // A face that could not be measured is no evidence of sharpness.
        XCTAssertEqual(FocusPeaking.classify(.nan), .unsharp)
    }

    func testTheThresholdsAreOrdered() {
        XCTAssertGreaterThan(FocusPeaking.sharpMin, FocusPeaking.mediumMin)
    }

    // MARK: - Normalization

    func testVarianceScalesToTheFullScaleValue() {
        XCTAssertEqual(
            FocusPeaking.normalize(variance: FocusPeaking.laplacianFullScale),
            1, accuracy: 0.0001
        )
        XCTAssertEqual(
            FocusPeaking.normalize(variance: FocusPeaking.laplacianFullScale / 2),
            0.5, accuracy: 0.0001
        )
    }

    func testAVerySharpCropDoesNotScorePastOne() {
        XCTAssertEqual(FocusPeaking.normalize(variance: 100_000), 1, accuracy: 0.0001)
    }

    func testNoVarianceIsNoSharpness() {
        XCTAssertEqual(FocusPeaking.normalize(variance: 0), 0, accuracy: 0.0001)
        XCTAssertEqual(FocusPeaking.normalize(variance: -5), 0, accuracy: 0.0001)
        XCTAssertEqual(FocusPeaking.normalize(variance: .nan), 0, accuracy: 0.0001)
    }

    // MARK: - Display rules

    func testATinyFaceOnScreenGetsNoFrame() {
        // A dozen overlapping boxes on a crowd shot say less than none.
        XCTAssertFalse(FocusPeaking.isLegible(width: 12, height: 12))
        XCTAssertFalse(FocusPeaking.isLegible(width: 200, height: 8), "the smaller side decides")
    }

    func testAFaceBigEnoughToReadGetsOne() {
        XCTAssertTrue(FocusPeaking.isLegible(
            width: FocusPeaking.minRenderedFacePoints,
            height: FocusPeaking.minRenderedFacePoints
        ))
        XCTAssertTrue(FocusPeaking.isLegible(width: 120, height: 90))
    }

    func testNonsenseSizesAreNotLegible() {
        XCTAssertFalse(FocusPeaking.isLegible(width: .nan, height: 100))
        XCTAssertFalse(FocusPeaking.isLegible(width: 100, height: .infinity))
    }

    func testChromeShrinksAsTheZoomGrows() {
        // The box grows with the zoom; its border must not, or a 2 pt outline
        // reads as a smudge.
        XCTAssertEqual(FocusPeaking.chromeScale(zoom: 1), 1, accuracy: 0.0001)
        XCTAssertEqual(FocusPeaking.chromeScale(zoom: 2), 0.5, accuracy: 0.0001)
    }

    func testChromeNeverThinsToNothing() {
        XCTAssertEqual(
            FocusPeaking.chromeScale(zoom: 100),
            FocusPeaking.minChromeScale, accuracy: 0.0001
        )
    }

    func testChromeIsNotEnlargedBelowOneToOne() {
        // Zooming out must not fatten the border either.
        XCTAssertEqual(FocusPeaking.chromeScale(zoom: 0.5), 1, accuracy: 0.0001)
    }

    func testANonsenseZoomLeavesTheChromeAlone() {
        XCTAssertEqual(FocusPeaking.chromeScale(zoom: 0), 1, accuracy: 0.0001)
        XCTAssertEqual(FocusPeaking.chromeScale(zoom: .nan), 1, accuracy: 0.0001)
    }

    // MARK: - Labels

    func testTheLabelIsAWholePercentage() {
        XCTAssertEqual(FocusPeaking.label(score: 0.723), "72 %")
        XCTAssertEqual(FocusPeaking.label(score: 1), "100 %")
        XCTAssertEqual(FocusPeaking.label(score: 0), "0 %")
    }

    func testAnOutOfRangeScoreIsClampedForDisplay() {
        XCTAssertEqual(FocusPeaking.label(score: 1.5), "100 %")
        XCTAssertEqual(FocusPeaking.label(score: -0.5), "0 %")
        XCTAssertEqual(FocusPeaking.label(score: .nan), "0 %")
    }

    func testTheDescriptionNamesTheLevelAndTheNumber() {
        XCTAssertEqual(FocusPeaking.describe(score: 0.72), "Gesicht scharf – 72 %")
        XCTAssertEqual(FocusPeaking.describe(score: 0.25), "Gesicht mittelscharf – 25 %")
        XCTAssertEqual(FocusPeaking.describe(score: 0.05), "Gesicht unscharf – 5 %")
    }

    // MARK: - Crop rect

    private func bbox(
        x: Double, y: Double, w: Double, h: Double
    ) -> PhotoCompare.BBox {
        PhotoCompare.BBox(x: x, y: y, width: w, height: h)
    }

    func testACropIsTheBoxInPixels() throws {
        let rect = try XCTUnwrap(FocusPeaking.cropRect(
            for: bbox(x: 0.25, y: 0.5, w: 0.25, h: 0.25),
            imageWidth: 400, imageHeight: 400
        ))
        XCTAssertEqual(rect.minX, 100, accuracy: 0.001)
        XCTAssertEqual(rect.minY, 200, accuracy: 0.001)
        XCTAssertEqual(rect.width, 100, accuracy: 0.001)
        XCTAssertEqual(rect.height, 100, accuracy: 0.001)
    }

    func testACropIsClampedToTheImage() throws {
        // A box overhanging the right edge is trimmed, not refused.
        let rect = try XCTUnwrap(FocusPeaking.cropRect(
            for: bbox(x: 0.9, y: 0.9, w: 0.3, h: 0.3),
            imageWidth: 400, imageHeight: 400
        ))
        XCTAssertEqual(rect.maxX, 400, accuracy: 0.001)
        XCTAssertEqual(rect.maxY, 400, accuracy: 0.001)
    }

    func testATooSmallCropIsNotWorthMeasuring() {
        // Below the minimum there is not enough detail for a reading.
        XCTAssertNil(FocusPeaking.cropRect(
            for: bbox(x: 0.5, y: 0.5, w: 0.01, h: 0.01),
            imageWidth: 400, imageHeight: 400
        ))
    }

    func testABoxInSomeOtherCoordinateSpaceIsRefused() {
        // Pixel coordinates mistaken for normalized ones must not be measured
        // as if they were normalized.
        XCTAssertNil(FocusPeaking.cropRect(
            for: bbox(x: 120, y: 80, w: 40, h: 40),
            imageWidth: 400, imageHeight: 400
        ))
    }

    func testASlightOverhangIsStillAFace() throws {
        // Detectors emit these; they are real faces at the edge of the frame.
        let rect = try XCTUnwrap(FocusPeaking.cropRect(
            for: bbox(x: -0.05, y: 0.1, w: 0.3, h: 0.3),
            imageWidth: 400, imageHeight: 400
        ))
        XCTAssertEqual(rect.minX, 0, accuracy: 0.001)
    }

    func testADegenerateBoxIsRefused() {
        XCTAssertNil(FocusPeaking.cropRect(
            for: bbox(x: 0.5, y: 0.5, w: 0, h: 0.2),
            imageWidth: 400, imageHeight: 400
        ))
        XCTAssertNil(FocusPeaking.cropRect(
            for: bbox(x: .nan, y: 0.5, w: 0.2, h: 0.2),
            imageWidth: 400, imageHeight: 400
        ))
    }

    func testAnImageWithNoSizeYieldsNoCrop() {
        XCTAssertNil(FocusPeaking.cropRect(
            for: bbox(x: 0.25, y: 0.25, w: 0.5, h: 0.5),
            imageWidth: 0, imageHeight: 400
        ))
    }

    // MARK: - Grayscale

    func testWhitePixelsAreFullLuma() {
        let white: [UInt8] = [255, 255, 255, 255]
        XCTAssertEqual(FocusPeaking.grayscale(fromRGBA: white)[0], 255, accuracy: 0.001)
    }

    func testBlackPixelsAreNoLuma() {
        let black: [UInt8] = [0, 0, 0, 255]
        XCTAssertEqual(FocusPeaking.grayscale(fromRGBA: black)[0], 0, accuracy: 0.001)
    }

    func testGreenWeighsMostAndBlueLeast() {
        // Rec. 601: the eye is most sensitive to green.
        let red = FocusPeaking.grayscale(fromRGBA: [255, 0, 0, 255])[0]
        let green = FocusPeaking.grayscale(fromRGBA: [0, 255, 0, 255])[0]
        let blue = FocusPeaking.grayscale(fromRGBA: [0, 0, 255, 255])[0]
        XCTAssertGreaterThan(green, red)
        XCTAssertGreaterThan(red, blue)
    }

    func testAlphaIsIgnored() {
        let opaque = FocusPeaking.grayscale(fromRGBA: [120, 120, 120, 255])[0]
        let transparent = FocusPeaking.grayscale(fromRGBA: [120, 120, 120, 0])[0]
        XCTAssertEqual(opaque, transparent, accuracy: 0.001)
    }

    // MARK: - Laplacian

    /// A flat grey field — nothing to focus on.
    private func flat(_ width: Int, _ height: Int, value: Double = 128) -> [Double] {
        [Double](repeating: value, count: width * height)
    }

    /// A one-pixel checkerboard — the sharpest edge structure there is.
    private func checkerboard(_ width: Int, _ height: Int) -> [Double] {
        (0..<(width * height)).map { index in
            let row = index / width
            let column = index % width
            return (row + column) % 2 == 0 ? 0 : 255
        }
    }

    func testAFlatFieldHasNoEdges() {
        XCTAssertEqual(
            FocusPeaking.laplacianVariance(gray: flat(16, 16), width: 16, height: 16),
            0, accuracy: 0.0001
        )
    }

    func testACheckerboardIsFullOfEdges() {
        let variance = FocusPeaking.laplacianVariance(
            gray: checkerboard(16, 16), width: 16, height: 16
        )
        XCTAssertGreaterThan(variance, FocusPeaking.laplacianFullScale)
        XCTAssertEqual(FocusPeaking.normalize(variance: variance), 1, accuracy: 0.0001)
    }

    func testASharpCropScoresAboveABlurredOne() {
        // The whole point of the measurement, on the same image blurred.
        let sharp = checkerboard(16, 16)
        // A crude blur: average each pixel with its row neighbours.
        var blurred = sharp
        for row in 0..<16 {
            for column in 1..<15 {
                let index = row * 16 + column
                blurred[index] = (sharp[index - 1] + sharp[index] + sharp[index + 1]) / 3
            }
        }
        let sharpVariance = FocusPeaking.laplacianVariance(gray: sharp, width: 16, height: 16)
        let blurredVariance = FocusPeaking.laplacianVariance(gray: blurred, width: 16, height: 16)
        XCTAssertGreaterThan(sharpVariance, blurredVariance)
    }

    func testAGradientIsNotMistakenForAnEdge() {
        // A smooth ramp has a constant Laplacian, so its variance is zero —
        // this is what keeps soft lighting from reading as sharpness.
        let width = 16, height = 16
        let ramp = (0..<(width * height)).map { Double(($0 % width) * 16) }
        XCTAssertEqual(
            FocusPeaking.laplacianVariance(gray: ramp, width: width, height: height),
            0, accuracy: 0.0001
        )
    }

    func testOnlyTheInteriorIsMeasured() {
        // The embedding service wraps neighbours around the edges, which on a
        // small crop turns a brightness difference between opposite edges into
        // a fake edge — a smoothly lit, out-of-focus face then reads as sharp.
        // Skipping the border instead means a 3x3 has exactly *one* measured
        // pixel, and one sample has no variance however wild the ring around
        // it is. Wrapping would measure all nine and report a large one.
        let field: [Double] = [
            0, 255, 0,
            255, 128, 255,
            0, 255, 0,
        ]
        XCTAssertEqual(
            FocusPeaking.laplacianVariance(gray: field, width: 3, height: 3),
            0, accuracy: 0.0001
        )
    }

    func testACropTooSmallToHaveAnInteriorScoresZero() {
        // Fewer than 3 pixels a side leaves nothing but border.
        XCTAssertEqual(
            FocusPeaking.laplacianVariance(gray: flat(2, 2), width: 2, height: 2),
            0, accuracy: 0.0001
        )
    }

    func testTruncatedPixelDataIsNotMeasured() {
        XCTAssertEqual(
            FocusPeaking.laplacianVariance(gray: [1, 2, 3], width: 16, height: 16),
            0, accuracy: 0.0001
        )
    }

    // MARK: - End to end

    func testAFlatCropReadsAsUnsharpAndACheckerboardAsSharp() {
        let flatPixels = [UInt8](repeating: 128, count: 16 * 16 * 4)
        XCTAssertEqual(
            FocusPeaking.classify(
                FocusPeaking.sharpness(fromRGBA: flatPixels, width: 16, height: 16)
            ),
            .unsharp
        )

        var checkerPixels = [UInt8](repeating: 255, count: 16 * 16 * 4)
        for index in 0..<(16 * 16) {
            let value: UInt8 = ((index / 16) + (index % 16)) % 2 == 0 ? 0 : 255
            checkerPixels[index * 4] = value
            checkerPixels[index * 4 + 1] = value
            checkerPixels[index * 4 + 2] = value
        }
        XCTAssertEqual(
            FocusPeaking.classify(
                FocusPeaking.sharpness(fromRGBA: checkerPixels, width: 16, height: 16)
            ),
            .sharp
        )
    }
}
