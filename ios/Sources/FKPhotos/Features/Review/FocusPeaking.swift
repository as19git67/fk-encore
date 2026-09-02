import CoreGraphics
import Foundation

/// Which faces in a photo are actually in focus.
///
/// A port of the web's `frontend/src/utils/focusPeaking.ts`. When picking
/// between a burst of near-identical shots the deciding question is usually
/// „which one has the faces sharp?", and this answers it by measuring rather
/// than by eye: crop the face, take the variance of its Laplacian, and colour
/// the frame green, yellow or red.
///
/// The metric mirrors the one the embedding service computes for
/// `face_sharpness`, and the constants are the web's, so the colours on the
/// phone agree with the AI quality scores shown beside them and with what the
/// same photo shows in a browser.
///
/// Everything here is pure — pixels in, numbers out.
enum FocusPeaking {

    // MARK: - Constants

    /// The variance that counts as fully sharp. The same full-scale value the
    /// embedding service normalizes against.
    static let laplacianFullScale: Double = 500

    /// A face crop smaller than this carries too little detail to measure.
    static let minFacePixels = 10

    /// Below this on-screen size a frame says nothing: a dozen tiny boxes with
    /// overlapping labels on a crowd shot are worse than none.
    static let minRenderedFacePoints: Double = 40

    /// At or above this score a face is in focus.
    static let sharpMin: Double = 0.45
    /// At or above this it is acceptable; below, out of focus.
    static let mediumMin: Double = 0.18

    /// Floor for the chrome counter-scale, so a border never thins to an
    /// invisible hairline at full zoom.
    static let minChromeScale: Double = 0.4

    // MARK: - Levels

    enum Level: String, Sendable {
        case sharp, medium, unsharp

        /// What the frame is called out loud.
        var word: String {
            switch self {
            case .sharp: return "scharf"
            case .medium: return "mittelscharf"
            case .unsharp: return "unscharf"
            }
        }
    }

    /// A score on the traffic light. A score that is not a number reads as out
    /// of focus rather than throwing — a face that could not be measured is
    /// not evidence of sharpness.
    static func classify(_ score: Double) -> Level {
        guard score.isFinite else { return .unsharp }
        if score >= sharpMin { return .sharp }
        if score >= mediumMin { return .medium }
        return .unsharp
    }

    /// A raw Laplacian variance as a 0…1 score.
    static func normalize(variance: Double) -> Double {
        guard variance.isFinite, variance > 0 else { return 0 }
        return min(1, variance / laplacianFullScale)
    }

    // MARK: - Display rules

    /// Whether a face drawn this big is worth framing.
    static func isLegible(width: Double, height: Double) -> Bool {
        guard width.isFinite, height.isFinite else { return false }
        return min(width, height) >= minRenderedFacePoints
    }

    /// How much to shrink a frame's border and label to cancel out the zoom
    /// applied to their ancestor.
    ///
    /// The frame's *box* must grow with the zoom — it traces the face. Its
    /// border and label are chrome, and would otherwise thicken into a smudge.
    /// Clamped so they never disappear entirely.
    static func chromeScale(zoom: Double) -> Double {
        guard zoom.isFinite, zoom > 0 else { return 1 }
        return max(minChromeScale, min(1, 1 / zoom))
    }

    /// The percentage inside a frame, e.g. „72 %".
    static func label(score: Double) -> String {
        let clamped = score.isFinite ? min(max(score, 0), 1) : 0
        return "\(Int((clamped * 100).rounded())) %"
    }

    /// What a frame is announced as, e.g. „Gesicht scharf – 72 %".
    static func describe(score: Double) -> String {
        "Gesicht \(classify(score).word) – \(label(score: score))"
    }

    // MARK: - Cropping

    /// The pixel rectangle a normalized face box covers, clamped to the image.
    ///
    /// Nil when the box is unusable or the crop comes out too small to
    /// measure. Boxes a little past the edge are accepted — detectors emit
    /// those — but one wildly outside 0…1 is in some other coordinate space
    /// and must not be measured as if it were not.
    static func cropRect(
        for bbox: PhotoCompare.BBox,
        imageWidth: Int,
        imageHeight: Int
    ) -> CGRect? {
        guard imageWidth > 0, imageHeight > 0 else { return nil }
        guard [bbox.x, bbox.y, bbox.width, bbox.height].allSatisfy({ $0.isFinite }) else {
            return nil
        }
        guard bbox.width > 0, bbox.height > 0 else { return nil }
        guard bbox.x >= -0.1, bbox.x <= 1.1, bbox.y >= -0.1, bbox.y <= 1.1 else {
            return nil
        }

        let left = max(0, Int((bbox.x * Double(imageWidth)).rounded()))
        let top = max(0, Int((bbox.y * Double(imageHeight)).rounded()))
        let right = min(imageWidth, Int(((bbox.x + bbox.width) * Double(imageWidth)).rounded()))
        let bottom = min(imageHeight, Int(((bbox.y + bbox.height) * Double(imageHeight)).rounded()))
        let width = right - left
        let height = bottom - top
        guard width >= minFacePixels, height >= minFacePixels else { return nil }
        return CGRect(x: left, y: top, width: width, height: height)
    }

    // MARK: - Measuring

    /// Rec. 601 luma from packed RGBA bytes.
    static func grayscale(fromRGBA data: [UInt8]) -> [Double] {
        let count = data.count / 4
        guard count > 0 else { return [] }
        var out = [Double](repeating: 0, count: count)
        for index in 0..<count {
            let offset = index * 4
            out[index] = 0.299 * Double(data[offset])
                + 0.587 * Double(data[offset + 1])
                + 0.114 * Double(data[offset + 2])
        }
        return out
    }

    /// Variance of the four-neighbour Laplacian over the interior pixels.
    ///
    /// The embedding service approximates this with `np.roll`, which wraps
    /// neighbours around the edges. Harmless on a whole photo; on a small face
    /// crop the wrap turns any brightness difference between opposite edges
    /// into a fake edge, and a smoothly lit out-of-focus face reads as sharp.
    /// The border row and column are skipped instead — the same departure the
    /// web makes, for the same reason.
    static func laplacianVariance(gray: [Double], width: Int, height: Int) -> Double {
        let pixels = width * height
        guard pixels > 0, gray.count >= pixels else { return 0 }
        guard width >= 3, height >= 3 else { return 0 }

        let count = (width - 2) * (height - 2)
        var values = [Double](repeating: 0, count: count)
        var sum: Double = 0
        var index = 0
        for row in 1..<(height - 1) {
            let here = row * width
            let up = here - width
            let down = here + width
            for column in 1..<(width - 1) {
                let value = gray[up + column]
                    + gray[down + column]
                    + gray[here + column - 1]
                    + gray[here + column + 1]
                    - 4 * gray[here + column]
                values[index] = value
                sum += value
                index += 1
            }
        }
        let mean = sum / Double(count)
        var accumulated: Double = 0
        for value in values {
            let difference = value - mean
            accumulated += difference * difference
        }
        return accumulated / Double(count)
    }

    /// The 0…1 sharpness of a packed RGBA crop.
    static func sharpness(fromRGBA data: [UInt8], width: Int, height: Int) -> Double {
        normalize(variance: laplacianVariance(
            gray: grayscale(fromRGBA: data), width: width, height: height
        ))
    }

    // MARK: - Reading pixels

    /// Measure one face in an image.
    ///
    /// Nil when the box does not yield a crop worth measuring, so a caller can
    /// tell "no reading" from "reads as unsharp" — the two mean different
    /// things to someone choosing between two shots.
    static func sharpness(of bbox: PhotoCompare.BBox, in image: CGImage) -> Double? {
        guard let rect = cropRect(
            for: bbox, imageWidth: image.width, imageHeight: image.height
        ), let crop = image.cropping(to: rect) else { return nil }

        let width = crop.width
        let height = crop.height
        guard width >= 3, height >= 3 else { return nil }

        var data = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(
            data: &data,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.draw(crop, in: CGRect(x: 0, y: 0, width: width, height: height))
        return sharpness(fromRGBA: data, width: width, height: height)
    }
}
