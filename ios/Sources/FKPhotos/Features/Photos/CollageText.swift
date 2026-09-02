import CoreGraphics
import Foundation
import UIKit

/// The caption laid over a collage (#1020, stage C).
///
/// A port of the web's `frontend/src/utils/collageText.ts` and the drawing
/// half of `CollageDialog`. The overlay is positioned by its **centre**, in
/// normalized canvas coordinates, so it survives a layout switch: changing to
/// a taller variant changes the canvas aspect, not where the text sits within
/// it.
///
/// Font sizes are a fraction of the canvas **height** rather than a point
/// size, which is what makes the preview and the exported JPEG agree — the
/// preview multiplies the fraction by the size on screen, the render by 2400
/// pixels, and the caption covers the same share of the picture either way.
///
/// Everything here is pure except `dominantColors`, which reads pixels.
enum CollageText {

    // MARK: - Fonts

    struct FontPreset: Identifiable, Equatable, Sendable {
        enum Key: String, CaseIterable, Sendable {
            case small, medium, large
        }

        let key: Key
        let label: String
        /// Font size as a fraction of the canvas height.
        let heightFraction: Double

        var id: Key { key }
    }

    static let fonts: [FontPreset] = [
        FontPreset(key: .small, label: "Klein", heightFraction: 0.05),
        FontPreset(key: .medium, label: "Mittel", heightFraction: 0.08),
        FontPreset(key: .large, label: "Groß", heightFraction: 0.13),
    ]

    /// The preset for a key, falling back to medium — the same fallback the
    /// web makes, so an overlay written by one client renders on the other
    /// even if the presets ever diverge.
    static func font(_ key: FontPreset.Key) -> FontPreset {
        fonts.first { $0.key == key } ?? fonts[1]
    }

    // MARK: - The overlay

    enum Align: String, CaseIterable, Sendable {
        case left, center, right
    }

    struct Overlay: Identifiable, Equatable, Sendable {
        let id = UUID()
        var text: String = ""
        /// Normalized centre within the canvas.
        var x: Double = 0.5
        var y: Double = 0.5
        var fontKey: FontPreset.Key = .medium
        var align: Align = .center
        /// Fill colour as a hex string, e.g. `"#ffffff"` — the web's format,
        /// so the two clients describe a caption the same way.
        var colorHex: String = "#ffffff"

        static func == (lhs: Overlay, rhs: Overlay) -> Bool {
            lhs.id == rhs.id
                && lhs.text == rhs.text
                && lhs.x == rhs.x
                && lhs.y == rhs.y
                && lhs.fontKey == rhs.fontKey
                && lhs.align == rhs.align
                && lhs.colorHex == rhs.colorHex
        }
    }

    /// Where a fresh caption starts, and each subsequent one, so two captions
    /// added in a row do not land exactly on top of each other.
    static func newOverlay(existingCount: Int) -> Overlay {
        var overlay = Overlay()
        let offset = Double(existingCount) * 0.1
        overlay.x = clampUnit(0.5 + offset)
        overlay.y = clampUnit(0.5 + offset)
        return overlay
    }

    /// Pull a value into 0…1. Something that is not a number lands in the
    /// middle rather than at an edge — a caption that vanished off the corner
    /// would look like a bug in the render.
    static func clampUnit(_ value: Double?) -> Double {
        guard let value, value.isFinite else { return 0.5 }
        return min(max(value, 0), 1)
    }

    /// Move a caption by a normalized delta, keeping it on the canvas.
    static func moved(_ overlay: Overlay, byX dx: Double, y dy: Double) -> Overlay {
        var out = overlay
        out.x = clampUnit(dx.isFinite ? overlay.x + dx : overlay.x)
        out.y = clampUnit(dy.isFinite ? overlay.y + dy : overlay.y)
        return out
    }

    // MARK: - Layout

    /// The share of the canvas width a caption may use before it wraps.
    static let widthFraction: Double = 0.9
    /// Line spacing, as a multiple of the font size.
    static let lineSpacing: Double = 1.25
    /// Where the first baseline sits below the top of the block, as a multiple
    /// of the font size — roughly one ascent.
    static let ascentFraction: Double = 0.8
    /// The dark outline behind the fill, as a multiple of the font size.
    static let strokeFraction: Double = 0.08
    /// The outline never goes thinner than this, so a small caption over a
    /// busy photo stays readable.
    static let minStroke: Double = 2

    static func fontSize(for overlay: Overlay, canvasHeight: Double) -> Double {
        guard canvasHeight.isFinite, canvasHeight > 0 else { return 0 }
        return font(overlay.fontKey).heightFraction * canvasHeight
    }

    static func strokeWidth(fontSize: Double) -> Double {
        max(minStroke, fontSize * strokeFraction)
    }

    /// Word-wrap into lines no wider than `maxWidth`.
    ///
    /// Explicit newlines always break, and a blank line stays blank — a
    /// caption with a deliberate gap in it keeps the gap. A single word wider
    /// than the line is left to overflow rather than broken mid-word, which is
    /// what the web's `word-break: normal` does and what reads better than a
    /// name split across two lines.
    static func wrapLines(
        _ text: String,
        maxWidth: Double,
        measure: (String) -> Double
    ) -> [String] {
        var out: [String] = []
        for paragraph in text.components(separatedBy: "\n") {
            let words = paragraph.split(whereSeparator: { $0.isWhitespace }).map(String.init)
            guard !words.isEmpty else {
                out.append("")
                continue
            }
            var line = ""
            for word in words {
                let candidate = line.isEmpty ? word : "\(line) \(word)"
                if !line.isEmpty, maxWidth > 0, measure(candidate) > maxWidth {
                    out.append(line)
                    line = word
                } else {
                    line = candidate
                }
            }
            out.append(line)
        }
        return out
    }

    /// Where the block of text sits on the canvas, and where its first
    /// baseline is.
    ///
    /// The block is centred on the overlay's point and sized to its content,
    /// capped at 90 % of the width — the same rule as the web's
    /// `max-width: 90%` plus `translate(-50%, -50%)`. The anchor is the x the
    /// text is drawn from, which depends on the alignment: a left-aligned
    /// block starts at its left edge, a right-aligned one at its right.
    struct Block: Equatable, Sendable {
        var lines: [String]
        var fontSize: Double
        var lineHeight: Double
        var width: Double
        var height: Double
        var centerX: Double
        var centerY: Double
        var anchorX: Double
        /// The top of the first line. UIKit draws text from a line's top-left,
        /// where the canvas API the web uses draws from its baseline; keeping
        /// the top here and deriving the baseline means one number describes
        /// both.
        var firstLineTop: Double

        /// Where the web's canvas would put the first baseline — one ascent
        /// below the top of the block.
        var firstBaseline: Double { firstLineTop + fontSize * CollageText.ascentFraction }

        /// The top of line `index`.
        func lineTop(_ index: Int) -> Double {
            firstLineTop + Double(index) * lineHeight
        }
    }

    static func block(
        for overlay: Overlay,
        canvas: CGSize,
        measure: (String, Double) -> Double
    ) -> Block? {
        let text = overlay.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let canvasWidth = Double(canvas.width)
        let canvasHeight = Double(canvas.height)
        let size = fontSize(for: overlay, canvasHeight: canvasHeight)
        guard size > 0, canvasWidth > 0 else { return nil }

        let maxWidth = canvasWidth * widthFraction
        let lines = wrapLines(overlay.text, maxWidth: maxWidth) { measure($0, size) }
        let lineHeight = size * lineSpacing
        let blockHeight = lineHeight * Double(lines.count)
        let widest = lines.map { measure($0, size) }.max() ?? 0
        let blockWidth = min(max(widest, 0), maxWidth)

        let centerX = clampUnit(overlay.x) * canvasWidth
        let centerY = clampUnit(overlay.y) * canvasHeight
        let anchorX: Double
        switch overlay.align {
        case .left: anchorX = centerX - blockWidth / 2
        case .right: anchorX = centerX + blockWidth / 2
        case .center: anchorX = centerX
        }

        return Block(
            lines: lines,
            fontSize: size,
            lineHeight: lineHeight,
            width: blockWidth,
            height: blockHeight,
            centerX: centerX,
            centerY: centerY,
            anchorX: anchorX,
            firstLineTop: centerY - blockHeight / 2
        )
    }

    // MARK: - Colours

    /// The colours always on offer, before anything is read from the photos.
    static let fixedColors = ["#ffffff", "#000000"]

    /// Up to `maxColors` vivid, distinct colours taken from the photos.
    ///
    /// Each image is drawn into a 64×64 buffer, its pixels quantised into
    /// 16-step buckets and scored by frequency × saturation², so a colour that
    /// is both common and vivid wins over one that is merely common. Near-grey
    /// and very dark pixels are skipped — they make poor caption colours — and
    /// results closer than 60 in RGB distance are dropped as duplicates, so
    /// the row offers genuinely different choices rather than six greens.
    ///
    /// The same rules as the web's `extractDominantColors`, which is not unit
    /// tested there because jsdom has no canvas. Here it is.
    static func dominantColors(from images: [UIImage], maxColors: Int = 6) -> [String] {
        let side = 64
        var scores: [Int: Double] = [:]

        for image in images {
            guard let pixels = rgbaPixels(of: image, side: side) else { continue }
            for index in stride(from: 0, to: pixels.count - 3, by: 4) {
                let red = Int(pixels[index])
                let green = Int(pixels[index + 1])
                let blue = Int(pixels[index + 2])
                // Rounding to the nearest 16 can land on 256, which is not a
                // colour: the web writes that out as a seven-digit hex string
                // and produces a swatch nothing can parse. Clamped here.
                let quantisedRed = quantise(red)
                let quantisedGreen = quantise(green)
                let quantisedBlue = quantise(blue)
                let maximum = max(quantisedRed, quantisedGreen, quantisedBlue)
                let minimum = min(quantisedRed, quantisedGreen, quantisedBlue)
                let saturation = maximum == 0
                    ? 0
                    : Double(maximum - minimum) / Double(maximum)
                guard saturation >= 0.2, maximum >= 40 else { continue }
                let key = (quantisedRed << 16) | (quantisedGreen << 8) | quantisedBlue
                scores[key, default: 0] += saturation * saturation
            }
        }

        // Ties broken by the colour itself, so the same photos always give the
        // same row rather than one that reshuffles between openings.
        let sorted = scores.sorted {
            $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value
        }
        var result: [(red: Int, green: Int, blue: Int)] = []
        for (key, _) in sorted {
            guard result.count < maxColors else { break }
            let red = (key >> 16) & 0xFF
            let green = (key >> 8) & 0xFF
            let blue = key & 0xFF
            let tooClose = result.contains { existing in
                let dr = Double(red - existing.red)
                let dg = Double(green - existing.green)
                let db = Double(blue - existing.blue)
                return (dr * dr + dg * dg + db * db).squareRoot() < 60
            }
            if !tooClose { result.append((red, green, blue)) }
        }
        return result.map { hex(red: $0.red, green: $0.green, blue: $0.blue) }
    }

    /// One channel to the nearest 16, never past white.
    private static func quantise(_ value: Int) -> Int {
        min(255, Int((Double(value) / 16).rounded()) * 16)
    }

    /// The whole palette: white and black, then whatever the photos offered.
    ///
    /// Deduplicated, so a photo that happens to yield white does not put two
    /// identical swatches in the row.
    static func palette(from images: [UIImage], maxColors: Int = 6) -> [String] {
        var seen = Set<String>()
        return (fixedColors + dominantColors(from: images, maxColors: maxColors))
            .filter { seen.insert($0).inserted }
    }

    static func hex(red: Int, green: Int, blue: Int) -> String {
        String(format: "#%02x%02x%02x", min(max(red, 0), 255), min(max(green, 0), 255), min(max(blue, 0), 255))
    }

    /// A hex string as a colour, or nil when it is not one.
    static func color(fromHex hex: String) -> UIColor? {
        var text = hex.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("#") { text.removeFirst() }
        guard text.count == 6, let value = Int(text, radix: 16) else { return nil }
        return UIColor(
            red: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: 1
        )
    }

    /// Draw an image into a small square buffer and hand back its bytes.
    private static func rgbaPixels(of image: UIImage, side: Int) -> [UInt8]? {
        guard let cgImage = image.cgImage, side > 0 else { return nil }
        var data = [UInt8](repeating: 0, count: side * side * 4)
        guard let context = CGContext(
            data: &data,
            width: side,
            height: side,
            bitsPerComponent: 8,
            bytesPerRow: side * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: side, height: side))
        return data
    }
}
