import CoreGraphics
import XCTest
@testable import FKPhotosLib

/// The hand editor's rules: what the server will accept, how a crop moves and
/// resizes, and the tone curve the live preview has to agree with.
final class PhotoRecipeTests: XCTestCase {

    // MARK: - Neutrality

    func testAnUntouchedRecipeChangesNothing() {
        XCTAssertTrue(PhotoRecipe.Recipe.neutral.isNeutral)
    }

    func testAnyOneEditIsEnoughToBeSomething() {
        var recipe = PhotoRecipe.Recipe.neutral
        recipe.exposure = 0.5
        XCTAssertFalse(recipe.isNeutral)

        var cropped = PhotoRecipe.Recipe.neutral
        cropped.crop = PhotoTransforms.Crop(x: 0, y: 0, w: 0.5, h: 0.5)
        XCTAssertFalse(cropped.isNeutral)

        var turned = PhotoRecipe.Recipe.neutral
        turned.rotation = 90
        XCTAssertFalse(turned.isNeutral)
    }

    func testGammaIsNeutralAtOneNotAtZero() {
        // It multiplies rather than adds, so 0 would be a black frame.
        var recipe = PhotoRecipe.Recipe.neutral
        recipe.gamma = 1
        XCTAssertTrue(recipe.isNeutral)
        recipe.gamma = 0
        XCTAssertFalse(recipe.isNeutral)
    }

    // MARK: - What the server accepts

    func testValuesOutsideTheServersRangeArePulledIn() {
        // A 400 on save would lose the whole edit, so nothing leaves here out
        // of range — whatever the sliders allowed.
        let wild = PhotoRecipe.Recipe(
            crop: nil, rotation: 45, exposure: 99, contrast: -5, gamma: 100,
            whitePoint: 3, blackPoint: -2
        )
        let saved = PhotoRecipe.clampedForSave(wild)
        XCTAssertEqual(saved.exposure, 3)
        XCTAssertEqual(saved.contrast, -1)
        XCTAssertEqual(saved.gamma, 5)
        // 45° is not a quarter turn; the server takes only 0/90/180/270.
        XCTAssertEqual(saved.rotation, 0)
    }

    func testNegativeRotationsComeBackAsQuarterTurns() {
        var recipe = PhotoRecipe.Recipe.neutral
        recipe.rotation = -90
        XCTAssertEqual(PhotoRecipe.clampedForSave(recipe).rotation, 270)
        recipe.rotation = 450
        XCTAssertEqual(PhotoRecipe.clampedForSave(recipe).rotation, 90)
    }

    func testAnImpossibleLevelsWindowIsDroppedRatherThanGuessed() {
        // The server rejects black >= white outright. Which of the two the
        // user meant is unknowable, so both go.
        var recipe = PhotoRecipe.Recipe.neutral
        recipe.blackPoint = 0.8
        recipe.whitePoint = 0.3
        let saved = PhotoRecipe.clampedForSave(recipe)
        XCTAssertNil(saved.blackPoint)
        XCTAssertNil(saved.whitePoint)
    }

    func testAValidLevelsWindowSurvives() {
        var recipe = PhotoRecipe.Recipe.neutral
        recipe.blackPoint = 0.1
        recipe.whitePoint = 0.9
        let saved = PhotoRecipe.clampedForSave(recipe)
        XCTAssertEqual(saved.blackPoint, 0.1)
        XCTAssertEqual(saved.whitePoint, 0.9)
    }

    func testACropReachingPastTheEdgeIsPulledBackNotThrownAway() {
        let crop = PhotoTransforms.Crop(x: 0.8, y: 0.9, w: 0.5, h: 0.4)
        let fixed = PhotoRecipe.validCrop(crop)
        XCTAssertNotNil(fixed)
        XCTAssertLessThanOrEqual((fixed?.x ?? 0) + (fixed?.w ?? 0), 1.000001)
        XCTAssertLessThanOrEqual((fixed?.y ?? 0) + (fixed?.h ?? 0), 1.000001)
        XCTAssertEqual(fixed?.w ?? 0, 0.5, accuracy: 0.000001)
    }

    func testACropWithNoAreaIsNoCrop() {
        XCTAssertNil(PhotoRecipe.validCrop(PhotoTransforms.Crop(x: 0, y: 0, w: 0, h: 0.5)))
        XCTAssertNil(PhotoRecipe.validCrop(PhotoTransforms.Crop(x: 0, y: 0, w: .nan, h: 0.5)))
    }

    // MARK: - Centred crops

    func testASquareCropOfALandscapePhotoIsTallAndNarrowInNormalizedSpace() {
        // 1:1 out of 3:2 keeps the full height and two thirds of the width.
        let crop = PhotoRecipe.centredCrop(
            ratio: .square, imageWidth: 3000, imageHeight: 2000
        )
        XCTAssertEqual(crop?.h ?? 0, 1, accuracy: 0.0001)
        XCTAssertEqual(crop?.w ?? 0, 2.0 / 3, accuracy: 0.0001)
        XCTAssertEqual(crop?.x ?? 0, (1 - 2.0 / 3) / 2, accuracy: 0.0001)
    }

    func testACentredCropIsCentred() {
        for ratio in PhotoTransforms.AspectRatio.allCases {
            guard let crop = PhotoRecipe.centredCrop(
                ratio: ratio, imageWidth: 4000, imageHeight: 3000
            ) else { return XCTFail("no crop for \(ratio.rawValue)") }
            XCTAssertEqual(crop.x + crop.w / 2, 0.5, accuracy: 0.0001, ratio.rawValue)
            XCTAssertEqual(crop.y + crop.h / 2, 0.5, accuracy: 0.0001, ratio.rawValue)
        }
    }

    func testACentredCropIsTheLargestThatFits() {
        for ratio in PhotoTransforms.AspectRatio.allCases {
            guard let crop = PhotoRecipe.centredCrop(
                ratio: ratio, imageWidth: 4000, imageHeight: 3000
            ) else { return XCTFail("no crop for \(ratio.rawValue)") }
            // One edge always uses the whole image; otherwise it could grow.
            XCTAssertEqual(max(crop.w, crop.h), 1, accuracy: 0.0001, ratio.rawValue)
            XCTAssertLessThanOrEqual(crop.w, 1.0001, ratio.rawValue)
            XCTAssertLessThanOrEqual(crop.h, 1.0001, ratio.rawValue)
        }
    }

    func testACentredCropHasTheRatioItWasAskedFor() {
        // The ratio is of pixels, and normalized coordinates are not square —
        // this is the step that is easy to get wrong.
        let width = 4000.0
        let height = 3000.0
        for ratio in PhotoTransforms.AspectRatio.allCases {
            guard let crop = PhotoRecipe.centredCrop(
                ratio: ratio, imageWidth: width, imageHeight: height
            ) else { return XCTFail("no crop for \(ratio.rawValue)") }
            let actual = (crop.w * width) / (crop.h * height)
            XCTAssertEqual(actual, ratio.value, accuracy: 0.001, ratio.rawValue)
        }
    }

    func testAnImageWithNoSizeYetHasNoCrop() {
        XCTAssertNil(PhotoRecipe.centredCrop(ratio: .square, imageWidth: 0, imageHeight: 0))
    }

    // MARK: - Recognising a ratio

    func testACropMadeAtARatioIsRecognisedAsThatRatio() {
        for ratio in PhotoTransforms.AspectRatio.allCases {
            guard let crop = PhotoRecipe.centredCrop(
                ratio: ratio, imageWidth: 4000, imageHeight: 3000
            ) else { return XCTFail("no crop for \(ratio.rawValue)") }
            XCTAssertEqual(
                PhotoRecipe.guessRatio(of: crop, imageWidth: 4000, imageHeight: 3000),
                ratio,
                ratio.rawValue
            )
        }
    }

    func testAFreehandCropStaysFreehand() {
        // 2.3:1 is none of the offered ratios; calling it 16:9 would silently
        // re-lock a crop the user made by hand.
        let crop = PhotoTransforms.Crop(x: 0, y: 0.2, w: 1, h: 0.58)
        XCTAssertNil(
            PhotoRecipe.guessRatio(of: crop, imageWidth: 4000, imageHeight: 3000)
        )
    }

    // MARK: - Moving a crop

    func testACropSlidesWithTheFinger() {
        let crop = PhotoTransforms.Crop(x: 0.2, y: 0.2, w: 0.4, h: 0.4)
        let moved = PhotoRecipe.moved(crop, byX: 0.1, y: -0.05)
        XCTAssertEqual(moved.x, 0.3, accuracy: 0.0001)
        XCTAssertEqual(moved.y, 0.15, accuracy: 0.0001)
    }

    func testACropStopsAtTheEdgeInsteadOfShrinking() {
        // The rectangle keeps its size; only its position is clamped.
        let crop = PhotoTransforms.Crop(x: 0.7, y: 0.7, w: 0.3, h: 0.3)
        let moved = PhotoRecipe.moved(crop, byX: 0.5, y: 0.5)
        XCTAssertEqual(moved.x, 0.7, accuracy: 0.0001)
        XCTAssertEqual(moved.y, 0.7, accuracy: 0.0001)
        XCTAssertEqual(moved.w, 0.3, accuracy: 0.0001)
        XCTAssertEqual(moved.h, 0.3, accuracy: 0.0001)
    }

    // MARK: - Resizing a crop

    func testDraggingACornerPinsTheOppositeOne() {
        let crop = PhotoTransforms.Crop(x: 0.2, y: 0.2, w: 0.5, h: 0.5)
        let resized = PhotoRecipe.resized(crop, corner: .topLeft, byX: 0.1, y: 0.1)
        // Bottom-right stayed put.
        XCTAssertEqual(resized.x + resized.w, 0.7, accuracy: 0.0001)
        XCTAssertEqual(resized.y + resized.h, 0.7, accuracy: 0.0001)
        XCTAssertEqual(resized.x, 0.3, accuracy: 0.0001)
    }

    func testAResizeNeverLeavesTheImage() {
        let crop = PhotoTransforms.Crop(x: 0.2, y: 0.2, w: 0.5, h: 0.5)
        for corner in PhotoRecipe.Corner.allCases {
            for (dx, dy) in [(2.0, 2.0), (-2.0, -2.0), (2.0, -2.0), (-2.0, 2.0)] {
                let resized = PhotoRecipe.resized(crop, corner: corner, byX: dx, y: dy)
                XCTAssertGreaterThanOrEqual(resized.x, -0.0001, "\(corner) \(dx),\(dy)")
                XCTAssertGreaterThanOrEqual(resized.y, -0.0001, "\(corner) \(dx),\(dy)")
                XCTAssertLessThanOrEqual(resized.x + resized.w, 1.0001, "\(corner) \(dx),\(dy)")
                XCTAssertLessThanOrEqual(resized.y + resized.h, 1.0001, "\(corner) \(dx),\(dy)")
            }
        }
    }

    func testACropCannotBeDraggedIntoNothing() {
        let crop = PhotoTransforms.Crop(x: 0.2, y: 0.2, w: 0.5, h: 0.5)
        // Dragging the corner exactly onto its anchor: the floor is what
        // keeps the rectangle grabbable instead of vanishing.
        let collapsed = PhotoRecipe.resized(crop, corner: .topLeft, byX: 0.5, y: 0.5)
        XCTAssertGreaterThanOrEqual(collapsed.w, PhotoRecipe.Limits.minCropFraction - 0.0001)
        XCTAssertGreaterThanOrEqual(collapsed.h, PhotoRecipe.Limits.minCropFraction - 0.0001)
    }

    func testALockedRatioSurvivesTheDrag() {
        let width = 4000.0
        let height = 3000.0
        guard let start = PhotoRecipe.centredCrop(
            ratio: .fourFive, imageWidth: width, imageHeight: height
        ) else { return XCTFail("no crop") }
        let resized = PhotoRecipe.resized(
            start, corner: .bottomRight, byX: -0.2, y: -0.05,
            ratio: .fourFive, imageWidth: width, imageHeight: height
        )
        let actual = (resized.w * width) / (resized.h * height)
        XCTAssertEqual(actual, PhotoTransforms.AspectRatio.fourFive.value, accuracy: 0.001)
        XCTAssertLessThan(resized.w, start.w)
    }

    func testALockedRatioStillHoldsWhenTheDragRunsOutOfImage() {
        // Clamping the two edges separately here would quietly unlock the
        // ratio — the crop has to shrink as a whole instead.
        let width = 4000.0
        let height = 3000.0
        let start = PhotoTransforms.Crop(x: 0.05, y: 0.05, w: 0.3, h: 0.3)
        let resized = PhotoRecipe.resized(
            start, corner: .bottomRight, byX: 5, y: 5,
            ratio: .nineSixteen, imageWidth: width, imageHeight: height
        )
        let actual = (resized.w * width) / (resized.h * height)
        XCTAssertEqual(actual, PhotoTransforms.AspectRatio.nineSixteen.value, accuracy: 0.001)
        XCTAssertLessThanOrEqual(resized.x + resized.w, 1.0001)
        XCTAssertLessThanOrEqual(resized.y + resized.h, 1.0001)
    }

    // MARK: - Rotation

    func testFourQuarterTurnsComeBackToTheStart() {
        var rotation = 0
        for _ in 0..<4 { rotation = PhotoRecipe.rotatedClockwise(rotation) }
        XCTAssertEqual(rotation, 0)
    }

    func testRotatingDoesNotMoveTheCrop() {
        // The server crops first and rotates after; a crop that moved with the
        // rotation would render as a different frame than the editor showed.
        var recipe = PhotoRecipe.Recipe.neutral
        recipe.crop = PhotoTransforms.Crop(x: 0.1, y: 0.2, w: 0.5, h: 0.4)
        var turned = recipe
        turned.rotation = PhotoRecipe.rotatedClockwise(turned.rotation)
        XCTAssertEqual(turned.crop, recipe.crop)
    }

    // MARK: - Tone curve

    func testANeutralRecipeLeavesEveryValueAlone() {
        let curve = PhotoRecipe.toneCurve(for: .neutral)
        XCTAssertTrue(curve.isIdentity)
        for value in [0.0, 0.25, 0.5, 0.75, 1.0] {
            XCTAssertEqual(curve.apply(value), value, accuracy: 0.0001)
        }
    }

    func testOneStopOfExposureDoublesTheValue() {
        var recipe = PhotoRecipe.Recipe.neutral
        recipe.exposure = 1
        let curve = PhotoRecipe.toneCurve(for: recipe)
        XCTAssertEqual(curve.apply(0.25), 0.5, accuracy: 0.0001)
        // And clips rather than overflowing.
        XCTAssertEqual(curve.apply(0.9), 1, accuracy: 0.0001)
    }

    func testContrastPivotsAroundMidGrey() {
        // The renderer pivots at 128/255; a pivot at 0.5 would drift the image
        // half a level darker than the file the server produces.
        var recipe = PhotoRecipe.Recipe.neutral
        recipe.contrast = 0.5
        let curve = PhotoRecipe.toneCurve(for: recipe)
        XCTAssertEqual(curve.apply(128.0 / 255.0), 128.0 / 255.0, accuracy: 0.0001)
        XCTAssertGreaterThan(curve.apply(0.8), 0.8)
        XCTAssertLessThan(curve.apply(0.2), 0.2)
    }

    func testTheBlackPointBecomesBlack() {
        var recipe = PhotoRecipe.Recipe.neutral
        recipe.blackPoint = 0.2
        recipe.whitePoint = 0.8
        let curve = PhotoRecipe.toneCurve(for: recipe)
        XCTAssertEqual(curve.apply(0.2), 0, accuracy: 0.0001)
        XCTAssertEqual(curve.apply(0.8), 1, accuracy: 0.0001)
        XCTAssertEqual(curve.apply(0.5), 0.5, accuracy: 0.0001)
    }

    func testAWindowTooNarrowToStretchIsIgnored() {
        var recipe = PhotoRecipe.Recipe.neutral
        recipe.blackPoint = 0.5
        recipe.whitePoint = 0.5
        let curve = PhotoRecipe.toneCurve(for: recipe)
        XCTAssertEqual(curve.levelsSlope, 1, accuracy: 0.0001)
    }

    func testGammaBrightensTheMidtones() {
        var recipe = PhotoRecipe.Recipe.neutral
        recipe.gamma = 2
        let curve = PhotoRecipe.toneCurve(for: recipe)
        XCTAssertEqual(curve.exponent, 0.5, accuracy: 0.0001)
        XCTAssertGreaterThan(curve.apply(0.25), 0.25)
        // The ends are fixed points whatever the gamma.
        XCTAssertEqual(curve.apply(0), 0, accuracy: 0.0001)
        XCTAssertEqual(curve.apply(1), 1, accuracy: 0.0001)
    }

    func testTheGammaTheServerCannotApplyIsNotPromisedEither() {
        // sharp takes only 1…3; a preview showing 0.5 would be a lie about the
        // file that comes back.
        var recipe = PhotoRecipe.Recipe.neutral
        recipe.gamma = 0.5
        XCTAssertEqual(PhotoRecipe.toneCurve(for: recipe).exponent, 1, accuracy: 0.0001)
        recipe.gamma = 9
        XCTAssertEqual(PhotoRecipe.toneCurve(for: recipe).exponent, 1.0 / 3, accuracy: 0.0001)
    }

    func testTheCurveStaysInsideTheVisibleRange() {
        var recipe = PhotoRecipe.Recipe.neutral
        recipe.exposure = 2
        recipe.contrast = 0.8
        recipe.gamma = 2
        recipe.blackPoint = 0.1
        recipe.whitePoint = 0.9
        let curve = PhotoRecipe.toneCurve(for: recipe)
        for step in 0...20 {
            let value = curve.apply(Double(step) / 20)
            XCTAssertGreaterThanOrEqual(value, 0)
            XCTAssertLessThanOrEqual(value, 1)
        }
    }

    func testNonsenseValuesDoNotProduceANonsenseCurve() {
        var recipe = PhotoRecipe.Recipe.neutral
        recipe.exposure = .nan
        recipe.contrast = .nan
        recipe.gamma = .nan
        XCTAssertTrue(PhotoRecipe.toneCurve(for: recipe).isIdentity)
    }

    // MARK: - Requests

    func testTheSaveBodyKeepsItsNulls() throws {
        // A missing field reads as „leave it alone" server-side, so clearing a
        // crop has to send an explicit null.
        let request = PhotoRecipe.UpsertRequest(.neutral)
        let data = try JSONEncoder().encode(request)
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        XCTAssertTrue(json.keys.contains("crop"))
        XCTAssertTrue(json["crop"] is NSNull)
        XCTAssertTrue(json["white_point"] is NSNull)
        XCTAssertEqual(json["gamma"] as? Double, 1)
    }

    func testTheSaveBodyIsAlreadyInRange() throws {
        var recipe = PhotoRecipe.Recipe.neutral
        recipe.exposure = 50
        let data = try JSONEncoder().encode(PhotoRecipe.UpsertRequest(recipe))
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        XCTAssertEqual(json["exposure"] as? Double, 3)
    }

    func testAutoLevelsOnlyTouchesTone() {
        // It measures brightness; the framing is the user's decision.
        var recipe = PhotoRecipe.Recipe.neutral
        recipe.crop = PhotoTransforms.Crop(x: 0.1, y: 0.1, w: 0.5, h: 0.5)
        recipe.rotation = 90
        let levelled = PhotoRecipe.applying(
            PhotoRecipe.AutoLevelsResult(exposure: 0.4, contrast: 0.2, gamma: 1.1),
            to: recipe
        )
        XCTAssertEqual(levelled.exposure, 0.4)
        XCTAssertEqual(levelled.contrast, 0.2)
        XCTAssertEqual(levelled.gamma, 1.1)
        XCTAssertEqual(levelled.crop, recipe.crop)
        XCTAssertEqual(levelled.rotation, 90)
    }

    // MARK: - Pixels

    func testAPixelRectIsWholePixels() {
        let rect = PhotoRecipe.pixelRect(
            PhotoTransforms.Crop(x: 1.0 / 3, y: 0, w: 1.0 / 3, h: 1),
            imageWidth: 1000, imageHeight: 800
        )
        for value in [rect.minX, rect.minY, rect.width, rect.height] {
            XCTAssertEqual(Double(value), Double(value).rounded(), accuracy: 0.0001)
        }
        XCTAssertEqual(Double(rect.height), 800, accuracy: 0.001)
    }
}
