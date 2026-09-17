import Foundation

// MARK: - Wire format

/// A point on a photo, relative to its width and height (0…1).
struct PhotoOcrPoint: Codable, Equatable, Sendable {
    let x: Double
    let y: Double
}

/// One recognised line of text in a photo (issue #1029).
///
/// The geometry is relative to the *original* image, 0…1 on both axes, so
/// it survives thumbnails, the viewer and whatever the server scaled the
/// photo to for recognition. `polygon` is the detector's own quadrilateral —
/// text on a sign photographed at an angle is not axis-aligned — and the
/// box is the rectangle around it, for callers that only need a rough
/// position. Corners are clockwise from the top-left, so the first edge is
/// the direction the text runs in.
struct PhotoOcrBlock: Codable, Equatable, Sendable {
    let text: String
    /// Recogniser confidence for this line, 0…1.
    let confidence: Double
    let polygon: [PhotoOcrPoint]
    let left: Double
    let top: Double
    let right: Double
    let bottom: Double
}

/// The stored reading of one photo. `blocks` is empty for a photo that was
/// scanned and simply has no text on it.
struct PhotoOcrResult: Codable, Equatable, Sendable {
    let photo_id: Int
    let blocks: [PhotoOcrBlock]
    let full_text: String
    let mean_confidence: Double
    let scanned_at: String
}

/// `GET /photos/:id/ocr`. `ocr` is nil for a photo that has not been through
/// recognition yet — deliberately distinct from a scanned photo with no text.
struct PhotoOcrResponse: Codable, Sendable {
    let ocr: PhotoOcrResult?
}

// MARK: - Layout

/// Geometry for laying recognised text over a photo (stage 5 of #1029).
///
/// Mirrors `frontend/src/utils/ocrLayout.ts`, case for case, so the two
/// clients cannot disagree about where a word is. Everything is pure and in
/// relative units; the view turns the result into points inside the
/// rendered image rectangle.
enum PhotoOcrLayout {

    /// What the image on screen was rendered with when a saved recipe is
    /// shown: the server extracts the crop from the upright original and then
    /// turns the result clockwise by the rotation (see `PhotoRecipe`).
    struct Viewport: Equatable, Sendable {
        var crop: PhotoTransforms.Crop?
        var rotation: Int

        init(crop: PhotoTransforms.Crop? = nil, rotation: Int = 0) {
            self.crop = crop
            self.rotation = rotation
        }
    }

    /// Where a line sits: `x`/`y` is the top-left corner in relative image
    /// coordinates, `width`/`height` the box in the same units, `angle` the
    /// clockwise rotation (radians) applied at that corner.
    struct Line: Equatable, Sendable {
        let text: String
        let confidence: Double
        let x: Double
        let y: Double
        let width: Double
        let height: Double
        let angle: Double
    }

    // MARK: Rotation

    /// Normalise any stored rotation to one of the four the server accepts.
    static func quarterTurn(_ rotation: Int) -> Int {
        let turn = ((Int((Double(rotation) / 90).rounded()) * 90) % 360 + 360) % 360
        return turn
    }

    /// Rotate a point inside the unit square clockwise by a quarter turn, the
    /// way the server turns the cropped image: the top-left corner ends up
    /// top-right after 90°.
    static func rotate(_ p: PhotoOcrPoint, by rotation: Int) -> PhotoOcrPoint {
        switch quarterTurn(rotation) {
        case 90: return PhotoOcrPoint(x: 1 - p.y, y: p.x)
        case 180: return PhotoOcrPoint(x: 1 - p.x, y: 1 - p.y)
        case 270: return PhotoOcrPoint(x: p.y, y: 1 - p.x)
        default: return p
        }
    }

    // MARK: Crop

    /// Re-base a point from the original onto a cropped view of it. Outside
    /// 0…1 for a point the crop cut off.
    static func map(_ p: PhotoOcrPoint, intoCrop crop: PhotoTransforms.Crop) -> PhotoOcrPoint {
        guard crop.w > 0, crop.h > 0 else { return p }
        return PhotoOcrPoint(x: (p.x - crop.x) / crop.w, y: (p.y - crop.y) / crop.h)
    }

    /// A block as it appears in the rendered view: re-based onto the crop,
    /// then turned with it. The bounding box is recomputed from the turned
    /// corners, because a turned rectangle's left is no longer its old left.
    static func map(_ block: PhotoOcrBlock, into view: Viewport) -> PhotoOcrBlock {
        var cropped = block
        if let crop = view.crop {
            let tl = map(PhotoOcrPoint(x: block.left, y: block.top), intoCrop: crop)
            let br = map(PhotoOcrPoint(x: block.right, y: block.bottom), intoCrop: crop)
            cropped = PhotoOcrBlock(
                text: block.text,
                confidence: block.confidence,
                polygon: block.polygon.map { map($0, intoCrop: crop) },
                left: tl.x, top: tl.y, right: br.x, bottom: br.y
            )
        }
        let turn = quarterTurn(view.rotation)
        guard turn != 0 else { return cropped }

        let polygon = cropped.polygon.map { rotate($0, by: turn) }
        let corners = [
            PhotoOcrPoint(x: cropped.left, y: cropped.top),
            PhotoOcrPoint(x: cropped.right, y: cropped.top),
            PhotoOcrPoint(x: cropped.right, y: cropped.bottom),
            PhotoOcrPoint(x: cropped.left, y: cropped.bottom),
        ].map { rotate($0, by: turn) }
        let xs = corners.map(\.x)
        let ys = corners.map(\.y)
        return PhotoOcrBlock(
            text: cropped.text,
            confidence: cropped.confidence,
            polygon: polygon,
            left: xs.min() ?? cropped.left,
            top: ys.min() ?? cropped.top,
            right: xs.max() ?? cropped.right,
            bottom: ys.max() ?? cropped.bottom
        )
    }

    // MARK: Lines

    /// Rotation of a line, from its top edge (first → second corner). Anything
    /// without two distinct corners counts as level.
    static func angle(of polygon: [PhotoOcrPoint]) -> Double {
        guard polygon.count >= 2 else { return 0 }
        let a = polygon[0], b = polygon[1]
        if a == b { return 0 }
        return atan2(b.y - a.y, b.x - a.x)
    }

    /// The box a line's text is laid into.
    ///
    /// With a full quad the box is anchored at the first corner, as long as
    /// the top edge and as tall as the left edge, rotated by the top edge's
    /// angle — an exact fit for the parallelogram-shaped quads the detector
    /// produces for tilted text. Without a usable quad it falls back to the
    /// axis-aligned box, which is what a level line is anyway.
    static func layout(_ block: PhotoOcrBlock) -> Line {
        if block.polygon.count >= 4 {
            let p0 = block.polygon[0], p1 = block.polygon[1], p3 = block.polygon[3]
            let width = hypot(p1.x - p0.x, p1.y - p0.y)
            let height = hypot(p3.x - p0.x, p3.y - p0.y)
            if width > 0, height > 0 {
                return Line(
                    text: block.text, confidence: block.confidence,
                    x: p0.x, y: p0.y, width: width, height: height,
                    angle: angle(of: block.polygon)
                )
            }
        }
        return Line(
            text: block.text, confidence: block.confidence,
            x: block.left, y: block.top,
            width: max(0, block.right - block.left),
            height: max(0, block.bottom - block.top),
            angle: 0
        )
    }

    /// True when a line is at least partly inside the visible area. A line
    /// the crop cut off entirely has nothing to select and is not laid out.
    static func isVisible(_ line: Line) -> Bool {
        line.x + line.width > 0 && line.y + line.height > 0 && line.x < 1 && line.y < 1
    }

    /// Horizontal stretch that makes text measured at `measuredWidth` fill a
    /// box of `targetWidth`, clamped against degenerate measurements.
    static func fitScaleX(measuredWidth: Double, targetWidth: Double) -> Double {
        guard measuredWidth > 0, targetWidth > 0,
              measuredWidth.isFinite, targetWidth.isFinite else { return 1 }
        return min(8, max(0.125, targetWidth / measuredWidth))
    }

    /// The whole pipeline: every block mapped into the view, laid out, and
    /// filtered to what can actually be seen.
    static func lines(_ blocks: [PhotoOcrBlock], view: Viewport? = nil) -> [Line] {
        blocks.compactMap { block in
            let mapped = view.map { map(block, into: $0) } ?? block
            let line = layout(mapped)
            guard line.width > 0, line.height > 0, isVisible(line) else { return nil }
            return line
        }
    }

    /// All text, in reading order — what "copy all" puts on the pasteboard.
    static func fullText(_ blocks: [PhotoOcrBlock]) -> String {
        blocks.map(\.text).joined(separator: "\n")
    }
}
