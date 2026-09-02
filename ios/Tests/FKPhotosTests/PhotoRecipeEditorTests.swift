import CoreImage
import UIKit
import XCTest
@testable import FKPhotosLib

/// The editor's image handling: the copy it edits at, and the tone pass the
/// live preview runs.
@MainActor
final class PhotoRecipeEditorTests: XCTestCase {

    private func image(width: Int, height: Int, white: Bool = false) -> UIImage {
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(
            size: CGSize(width: width, height: height), format: format
        ).image { context in
            (white ? UIColor.white : UIColor.gray).setFill()
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
    }

    // MARK: - The copy that gets edited

    func testABigPhotoIsShrunkToSomethingTheSlidersCanKeepUpWith() {
        let shrunk = PhotoRecipeEditorViewModel.downscaled(
            image(width: 4000, height: 3000), maxEdge: 1600
        )
        XCTAssertEqual(shrunk.size.width, 1600, accuracy: 1)
        XCTAssertEqual(shrunk.size.height, 1200, accuracy: 1)
    }

    func testAPortraitPhotoIsShrunkByItsLongEdgeToo() {
        let shrunk = PhotoRecipeEditorViewModel.downscaled(
            image(width: 3000, height: 4000), maxEdge: 1600
        )
        XCTAssertEqual(shrunk.size.height, 1600, accuracy: 1)
        XCTAssertEqual(shrunk.size.width, 1200, accuracy: 1)
    }

    func testAPhotoThatAlreadyFitsIsLeftAlone() {
        // Re-encoding a small photo would cost quality for nothing.
        let small = image(width: 800, height: 600)
        let result = PhotoRecipeEditorViewModel.downscaled(small, maxEdge: 1600)
        XCTAssertEqual(result.size, small.size)
    }

    func testShrinkingKeepsTheShape() {
        // The crop is normalized against this shape; a stretched copy would
        // make every locked ratio wrong.
        let original = image(width: 4032, height: 3024)
        let shrunk = PhotoRecipeEditorViewModel.downscaled(original, maxEdge: 1000)
        XCTAssertEqual(
            shrunk.size.width / shrunk.size.height,
            original.size.width / original.size.height,
            accuracy: 0.01
        )
    }

    // MARK: - The preview pass

    func testBrighteningActuallyBrightens() throws {
        var recipe = PhotoRecipe.Recipe.neutral
        recipe.exposure = 1
        let curve = PhotoRecipe.toneCurve(for: recipe)
        let source = image(width: 32, height: 32)
        let result = try XCTUnwrap(PhotoRecipeEditorViewModel.applyTone(
            curve, to: source, context: CIContext(options: nil)
        ))
        XCTAssertGreaterThan(try averageLuma(of: result), try averageLuma(of: source))
        XCTAssertEqual(result.size, source.size)
    }

    func testAWhiteFrameCannotBeBrightenedFurther() throws {
        // The curve clips; a preview that wrapped around would show garbage.
        var recipe = PhotoRecipe.Recipe.neutral
        recipe.exposure = 2
        let curve = PhotoRecipe.toneCurve(for: recipe)
        let white = image(width: 16, height: 16, white: true)
        let result = try XCTUnwrap(PhotoRecipeEditorViewModel.applyTone(
            curve, to: white, context: CIContext(options: nil)
        ))
        XCTAssertGreaterThan(try averageLuma(of: result), 0.9)
    }

    /// Mean luma of an image, 0…1.
    private func averageLuma(of image: UIImage) throws -> Double {
        let cgImage = try XCTUnwrap(image.cgImage)
        let width = cgImage.width
        let height = cgImage.height
        var data = [UInt8](repeating: 0, count: width * height * 4)
        let context = try XCTUnwrap(CGContext(
            data: &data,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        let gray = FocusPeaking.grayscale(fromRGBA: data)
        guard !gray.isEmpty else { return 0 }
        return gray.reduce(0, +) / Double(gray.count) / 255
    }
}
