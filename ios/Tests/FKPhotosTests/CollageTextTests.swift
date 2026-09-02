import CoreGraphics
import UIKit
import XCTest
@testable import FKPhotosLib

/// The collage caption: where it sits, how it wraps, and which colours it is
/// offered. The pure half of #1020 stage C.
final class CollageTextTests: XCTestCase {

    /// A stand-in for text measurement: one unit per character, so the wrap
    /// can be reasoned about without a font.
    private let measure: (String) -> Double = { Double($0.count) }

    // MARK: - Fonts

    func testEveryPresetIsFoundByItsKey() {
        for preset in CollageText.fonts {
            XCTAssertEqual(CollageText.font(preset.key).key, preset.key)
        }
    }

    func testThePresetsGrow() {
        // Klein < Mittel < Groß, or the picker would be lying.
        let sizes = CollageText.fonts.map(\.heightFraction)
        XCTAssertEqual(sizes, sizes.sorted())
        XCTAssertEqual(Set(sizes).count, sizes.count)
    }

    func testTheSameFractionsAsTheWeb() {
        // The two clients must render a caption at the same size, so these are
        // a contract, not a preference.
        XCTAssertEqual(CollageText.font(.small).heightFraction, 0.05, accuracy: 0.0001)
        XCTAssertEqual(CollageText.font(.medium).heightFraction, 0.08, accuracy: 0.0001)
        XCTAssertEqual(CollageText.font(.large).heightFraction, 0.13, accuracy: 0.0001)
    }

    // MARK: - Position

    func testAValueOutsideTheCanvasIsPulledOntoIt() {
        XCTAssertEqual(CollageText.clampUnit(-2), 0, accuracy: 0.0001)
        XCTAssertEqual(CollageText.clampUnit(3), 1, accuracy: 0.0001)
        XCTAssertEqual(CollageText.clampUnit(0.3), 0.3, accuracy: 0.0001)
    }

    func testSomethingThatIsNotANumberLandsInTheMiddle() {
        // Not at a corner: a caption that vanished off the edge would read as
        // a bug in the render rather than as bad input.
        XCTAssertEqual(CollageText.clampUnit(.nan), 0.5, accuracy: 0.0001)
        XCTAssertEqual(CollageText.clampUnit(nil), 0.5, accuracy: 0.0001)
    }

    func testASecondCaptionDoesNotLandOnTheFirst() {
        let first = CollageText.newOverlay(existingCount: 0)
        let second = CollageText.newOverlay(existingCount: 1)
        XCTAssertNotEqual(first.x, second.x)
        XCTAssertNotEqual(first.y, second.y)
    }

    func testCaptionsStayOnTheCanvasHoweverManyThereAre() {
        for count in 0..<20 {
            let overlay = CollageText.newOverlay(existingCount: count)
            XCTAssertGreaterThanOrEqual(overlay.x, 0)
            XCTAssertLessThanOrEqual(overlay.x, 1)
            XCTAssertGreaterThanOrEqual(overlay.y, 0)
            XCTAssertLessThanOrEqual(overlay.y, 1)
        }
    }

    func testACaptionDraggedOffTheEdgeStopsAtIt() {
        var overlay = CollageText.Overlay()
        overlay.x = 0.9
        overlay.y = 0.1
        let moved = CollageText.moved(overlay, byX: 0.5, y: -0.5)
        XCTAssertEqual(moved.x, 1, accuracy: 0.0001)
        XCTAssertEqual(moved.y, 0, accuracy: 0.0001)
    }

    // MARK: - Wrapping

    func testAShortLineDoesNotWrap() {
        XCTAssertEqual(
            CollageText.wrapLines("hallo welt", maxWidth: 100, measure: measure),
            ["hallo welt"]
        )
    }

    func testALongLineWrapsBetweenWords() {
        XCTAssertEqual(
            CollageText.wrapLines("aaa bbb ccc", maxWidth: 7, measure: measure),
            ["aaa bbb", "ccc"]
        )
    }

    func testAnExplicitBreakAlwaysBreaks() {
        XCTAssertEqual(
            CollageText.wrapLines("a\nb", maxWidth: 100, measure: measure),
            ["a", "b"]
        )
    }

    func testABlankLineStaysBlank() {
        // A caption written with a gap in it keeps the gap.
        XCTAssertEqual(
            CollageText.wrapLines("a\n\nb", maxWidth: 100, measure: measure),
            ["a", "", "b"]
        )
    }

    func testAWordTooLongForTheLineIsNotBrokenApart() {
        // A name split across two lines reads worse than one that overflows.
        XCTAssertEqual(
            CollageText.wrapLines("unaussprechlich", maxWidth: 5, measure: measure),
            ["unaussprechlich"]
        )
    }

    func testRunsOfSpacesCollapse() {
        XCTAssertEqual(
            CollageText.wrapLines("a   b", maxWidth: 100, measure: measure),
            ["a b"]
        )
    }

    func testNoWidthMeansNoWrapping() {
        // A zero width is "not measured yet", not "everything on its own line".
        XCTAssertEqual(
            CollageText.wrapLines("a b c d", maxWidth: 0, measure: measure),
            ["a b c d"]
        )
    }

    // MARK: - The block

    private func block(
        text: String,
        align: CollageText.Align = .center,
        font: CollageText.FontPreset.Key = .medium,
        x: Double = 0.5,
        y: Double = 0.5,
        canvas: CGSize = CGSize(width: 1000, height: 1000)
    ) -> CollageText.Block? {
        var overlay = CollageText.Overlay()
        overlay.text = text
        overlay.align = align
        overlay.fontKey = font
        overlay.x = x
        overlay.y = y
        // One unit per character, scaled by the font size, so the numbers stay
        // easy to follow.
        return CollageText.block(for: overlay, canvas: canvas) { line, size in
            Double(line.count) * size * 0.5
        }
    }

    func testAnEmptyCaptionHasNoBlock() {
        // Nothing to draw, and nothing to frame in the preview either.
        XCTAssertNil(block(text: ""))
        XCTAssertNil(block(text: "   \n  "))
    }

    func testTheFontSizeFollowsTheCanvasHeight() {
        // The same fraction of a 300 pt preview and a 2400 px render — which is
        // what makes the preview an honest picture of the result.
        let small = block(text: "x", canvas: CGSize(width: 300, height: 300))
        let large = block(text: "x", canvas: CGSize(width: 2400, height: 2400))
        XCTAssertEqual(small?.fontSize ?? 0, 0.08 * 300, accuracy: 0.001)
        XCTAssertEqual(large?.fontSize ?? 0, 0.08 * 2400, accuracy: 0.001)
    }

    func testTheBlockIsCentredOnItsPoint() {
        guard let block = block(text: "hallo", x: 0.25, y: 0.75) else {
            return XCTFail("no block")
        }
        XCTAssertEqual(block.centerX, 250, accuracy: 0.001)
        XCTAssertEqual(block.centerY, 750, accuracy: 0.001)
        // The block extends half its height either side of the point.
        XCTAssertEqual(block.firstLineTop, 750 - block.height / 2, accuracy: 0.001)
    }

    func testTheBaselineSitsOneAscentBelowTheTop() {
        // The web's canvas draws from the baseline, UIKit from the top; the two
        // have to describe the same line.
        guard let block = block(text: "hallo") else { return XCTFail("no block") }
        XCTAssertEqual(
            block.firstBaseline,
            block.firstLineTop + block.fontSize * CollageText.ascentFraction,
            accuracy: 0.001
        )
    }

    func testEachLineSitsBelowTheLast() {
        guard let block = block(text: "eins\nzwei\ndrei") else { return XCTFail("no block") }
        XCTAssertEqual(block.lines.count, 3)
        XCTAssertEqual(block.lineTop(1) - block.lineTop(0), block.lineHeight, accuracy: 0.001)
        XCTAssertEqual(block.height, block.lineHeight * 3, accuracy: 0.001)
    }

    func testTheBlockNeverGrowsPastNinetyPercentOfTheCanvas() {
        guard let block = block(text: String(repeating: "w", count: 500)) else {
            return XCTFail("no block")
        }
        XCTAssertLessThanOrEqual(block.width, 1000 * CollageText.widthFraction + 0.001)
    }

    func testAlignmentDecidesWhichEdgeTheTextIsDrawnFrom() {
        guard let left = block(text: "hallo", align: .left),
              let centre = block(text: "hallo", align: .center),
              let right = block(text: "hallo", align: .right)
        else { return XCTFail("no block") }
        XCTAssertEqual(left.anchorX, centre.centerX - left.width / 2, accuracy: 0.001)
        XCTAssertEqual(centre.anchorX, centre.centerX, accuracy: 0.001)
        XCTAssertEqual(right.anchorX, centre.centerX + right.width / 2, accuracy: 0.001)
    }

    // MARK: - The outline

    func testTheOutlineGrowsWithTheText() {
        XCTAssertEqual(CollageText.strokeWidth(fontSize: 200), 200 * 0.08, accuracy: 0.001)
    }

    func testASmallCaptionStillGetsAVisibleOutline() {
        // Over a busy photo a hairline outline is the same as none.
        XCTAssertEqual(CollageText.strokeWidth(fontSize: 10), CollageText.minStroke, accuracy: 0.001)
    }

    // MARK: - Colours

    private func image(_ color: UIColor, size: Int = 64) -> UIImage {
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(
            size: CGSize(width: size, height: size), format: format
        ).image { context in
            color.setFill()
            context.fill(CGRect(x: 0, y: 0, width: size, height: size))
        }
    }

    func testAVividPhotoOffersItsColour() throws {
        let colors = CollageText.dominantColors(from: [image(.red)])
        XCTAssertFalse(colors.isEmpty)
        // Red, give or take the 16-step quantisation — and a full 255 rather
        // than the 256 that rounding to the nearest 16 would otherwise give.
        XCTAssertEqual(try XCTUnwrap(colors.first), "#ff0000")
    }

    func testAGreyPhotoOffersNothing() {
        // Grey text on a photo is unreadable; the row is better left short.
        XCTAssertTrue(CollageText.dominantColors(from: [image(.gray)]).isEmpty)
    }

    func testADarkPhotoOffersNothing() {
        XCTAssertTrue(
            CollageText.dominantColors(from: [image(UIColor(white: 0.05, alpha: 1))]).isEmpty
        )
    }

    func testWhiteAndBlackAreAlwaysOffered() {
        let palette = CollageText.palette(from: [image(.gray)])
        XCTAssertEqual(Array(palette.prefix(2)), CollageText.fixedColors)
    }

    func testTheRowNeverRepeatsAColour() {
        // Two identical swatches side by side would look like one is broken.
        let palette = CollageText.palette(from: [image(.red), image(.blue)])
        XCTAssertEqual(Set(palette).count, palette.count)
    }

    func testTheRowIsNotSixShadesOfTheSameColour() {
        // Near-identical colours are dropped, so the swatches are actual
        // choices rather than a gradient.
        let colors = CollageText.dominantColors(
            from: [image(.red), image(UIColor(red: 1, green: 0.02, blue: 0.02, alpha: 1))]
        )
        XCTAssertEqual(colors.count, 1)
    }

    func testTwoDifferentColoursBothSurvive() {
        let colors = CollageText.dominantColors(from: [image(.red), image(.blue)])
        XCTAssertEqual(colors.count, 2)
    }

    func testNoMoreColoursThanAsked() {
        let images = [image(.red), image(.blue), image(.green), image(.magenta)]
        XCTAssertLessThanOrEqual(CollageText.dominantColors(from: images, maxColors: 2).count, 2)
    }

    func testTheSamePhotosAlwaysGiveTheSameRow() {
        // A palette that reshuffled between openings would move the swatch
        // under the user's thumb.
        let images = [image(.red), image(.blue), image(.green)]
        XCTAssertEqual(
            CollageText.dominantColors(from: images),
            CollageText.dominantColors(from: images)
        )
    }

    func testNoPhotosMeansNoColours() {
        XCTAssertTrue(CollageText.dominantColors(from: []).isEmpty)
    }

    // MARK: - Hex

    func testAHexStringRoundTrips() throws {
        let color = try XCTUnwrap(CollageText.color(fromHex: "#3366ff"))
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        XCTAssertEqual(Double(red), 0x33 / 255.0, accuracy: 0.01)
        XCTAssertEqual(Double(green), 0x66 / 255.0, accuracy: 0.01)
        XCTAssertEqual(Double(blue), 1, accuracy: 0.01)
    }

    func testAHexStringWithoutItsHashStillWorks() {
        XCTAssertNotNil(CollageText.color(fromHex: "ffffff"))
    }

    func testSomethingThatIsNotAColourIsNotOne() {
        XCTAssertNil(CollageText.color(fromHex: "#fff"))
        XCTAssertNil(CollageText.color(fromHex: "rot"))
        XCTAssertNil(CollageText.color(fromHex: ""))
    }

    func testTheHexFormatMatchesTheWebs() {
        // Lower case, six digits, leading hash — the format the web writes and
        // reads, so a caption means the same on both.
        XCTAssertEqual(CollageText.hex(red: 255, green: 0, blue: 128), "#ff0080")
        XCTAssertEqual(CollageText.hex(red: 0, green: 0, blue: 0), "#000000")
    }
}
