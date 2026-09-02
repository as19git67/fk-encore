import CoreGraphics
import Foundation

/// The editable half of a transform recipe: a crop rectangle, a rotation and
/// the tone values, plus everything needed to preview them before they are
/// saved (#1019, stage B).
///
/// `PhotoTransforms` covers *reviewing* what the AI or someone else proposed.
/// This covers making one by hand, which needs three things the review half
/// did not: geometry for dragging a crop around, a tone curve the phone can
/// apply locally so the preview is live rather than a round-trip, and the
/// ranges the server will accept so a save cannot come back a 400.
///
/// **Order of operations, and why it matters.** The server crops in the
/// EXIF-upright original and only *then* applies the recipe's own rotation
/// (`photo/photo-transforms-render.service.ts`). So a crop is always
/// expressed against the unrotated photo — rotating afterwards must not move
/// the crop rectangle, or the saved recipe would render as something else.
///
/// Pure: no image data, no network.
enum PhotoRecipe {

    // MARK: - The recipe

    /// What the editor is working on. Mirrors `UpsertTransformRequest`.
    struct Recipe: Equatable, Sendable {
        var crop: PhotoTransforms.Crop?
        var rotation: Int = 0
        var exposure: Double = 0
        var contrast: Double = 0
        var gamma: Double = 1
        var whitePoint: Double?
        var blackPoint: Double?

        static let neutral = Recipe()

        /// Whether this recipe would change the photo at all.
        var isNeutral: Bool {
            crop == nil
                && rotation == 0
                && abs(exposure) < 0.001
                && abs(contrast) < 0.001
                && abs(gamma - 1) < 0.001
                && whitePoint == nil
                && blackPoint == nil
        }

        init(
            crop: PhotoTransforms.Crop? = nil,
            rotation: Int = 0,
            exposure: Double = 0,
            contrast: Double = 0,
            gamma: Double = 1,
            whitePoint: Double? = nil,
            blackPoint: Double? = nil
        ) {
            self.crop = crop
            self.rotation = rotation
            self.exposure = exposure
            self.contrast = contrast
            self.gamma = gamma
            self.whitePoint = whitePoint
            self.blackPoint = blackPoint
        }

        /// The recipe already saved, so editing starts from what is on screen
        /// rather than from neutral.
        init(_ row: PhotoTransforms.Row) {
            self.init(
                crop: row.crop,
                rotation: row.rotation,
                exposure: row.exposure,
                contrast: row.contrast,
                gamma: row.gamma,
                whitePoint: row.white_point,
                blackPoint: row.black_point
            )
        }
    }

    // MARK: - Ranges

    /// What the sliders offer, and what the server accepts.
    ///
    /// The two are deliberately different: the server allows ±3 EV, the slider
    /// stops at ±2 like the web's, because the last stop in either direction
    /// is a photo nobody wants. Clamping on save uses the *server's* range, so
    /// a value that arrived from elsewhere — an adopted recipe, an AI
    /// suggestion — is never rejected just for sitting outside the slider.
    enum Limits {
        static let exposureSlider: ClosedRange<Double> = -2...2
        static let contrastSlider: ClosedRange<Double> = -1...1
        static let gammaSlider: ClosedRange<Double> = 0.5...2.5
        static let blackPointSlider: ClosedRange<Double> = 0...0.4
        static let whitePointSlider: ClosedRange<Double> = 0.6...1

        static let exposure: ClosedRange<Double> = -3...3
        static let contrast: ClosedRange<Double> = -1...1
        static let gamma: ClosedRange<Double> = 0.1...5
        static let point: ClosedRange<Double> = 0...1

        /// The smallest crop the editor lets you drag to, as a fraction of the
        /// image. Below this the handles overlap and the crop is unusable.
        static let minCropFraction: Double = 0.05
    }

    /// The recipe as the server will take it.
    ///
    /// Every value is pulled into range, and a black point at or above the
    /// white point — which the server rejects outright — drops both rather
    /// than guessing which one the user meant.
    static func clampedForSave(_ recipe: Recipe) -> Recipe {
        var out = recipe
        out.rotation = ((recipe.rotation % 360) + 360) % 360
        if out.rotation % 90 != 0 { out.rotation = 0 }
        out.exposure = clamp(recipe.exposure, to: Limits.exposure, default: 0)
        out.contrast = clamp(recipe.contrast, to: Limits.contrast, default: 0)
        out.gamma = clamp(recipe.gamma, to: Limits.gamma, default: 1)
        out.whitePoint = recipe.whitePoint.map { clamp($0, to: Limits.point, default: 1) }
        out.blackPoint = recipe.blackPoint.map { clamp($0, to: Limits.point, default: 0) }
        if let black = out.blackPoint, let white = out.whitePoint, black >= white {
            out.whitePoint = nil
            out.blackPoint = nil
        }
        out.crop = recipe.crop.flatMap(validCrop)
        return out
    }

    private static func clamp(
        _ value: Double, to range: ClosedRange<Double>, default fallback: Double
    ) -> Double {
        guard value.isFinite else { return fallback }
        return min(max(value, range.lowerBound), range.upperBound)
    }

    /// A crop the server will accept, or nil when there is nothing usable in
    /// it. A crop reaching past the edge is pulled back in rather than
    /// dropped — that is a rounding artefact, not a different intent.
    static func validCrop(_ crop: PhotoTransforms.Crop) -> PhotoTransforms.Crop? {
        guard [crop.x, crop.y, crop.w, crop.h].allSatisfy({ $0.isFinite }) else { return nil }
        guard crop.w > 0, crop.h > 0 else { return nil }
        let width = min(crop.w, 1)
        let height = min(crop.h, 1)
        let x = min(max(crop.x, 0), 1 - width)
        let y = min(max(crop.y, 0), 1 - height)
        return PhotoTransforms.Crop(x: x, y: y, w: width, h: height)
    }

    // MARK: - Crop geometry

    /// The largest centred crop of a given aspect ratio that fits the image.
    ///
    /// The ratio is of the *rendered pixels*, so it depends on the image's own
    /// shape: 1:1 out of a 3:2 photo is a tall-looking normalized rectangle.
    static func centredCrop(
        ratio: PhotoTransforms.AspectRatio,
        imageWidth: Double,
        imageHeight: Double
    ) -> PhotoTransforms.Crop? {
        guard imageWidth > 0, imageHeight > 0,
              imageWidth.isFinite, imageHeight.isFinite else { return nil }
        let relative = ratio.value / (imageWidth / imageHeight)
        let width = relative >= 1 ? 1 : relative
        let height = relative >= 1 ? 1 / relative : 1
        return PhotoTransforms.Crop(
            x: (1 - width) / 2, y: (1 - height) / 2, w: width, h: height
        )
    }

    /// Which listed ratio a crop is (near enough) at, so re-opening the editor
    /// shows the ratio the crop was made with instead of „frei".
    ///
    /// Nil when it matches none — a freehand crop stays freehand.
    static func guessRatio(
        of crop: PhotoTransforms.Crop,
        imageWidth: Double,
        imageHeight: Double,
        tolerance: Double = 0.05
    ) -> PhotoTransforms.AspectRatio? {
        guard imageWidth > 0, imageHeight > 0, crop.w > 0, crop.h > 0 else { return nil }
        let actual = (crop.w * imageWidth) / (crop.h * imageHeight)
        guard actual.isFinite else { return nil }
        var best: PhotoTransforms.AspectRatio?
        var bestError = tolerance
        for candidate in PhotoTransforms.AspectRatio.allCases {
            let error = abs(actual - candidate.value) / candidate.value
            if error < bestError {
                bestError = error
                best = candidate
            }
        }
        return best
    }

    /// Slide a crop by a normalized delta, stopping at the edges of the image.
    ///
    /// The rectangle keeps its size: running into an edge stops the drag
    /// rather than squashing the crop, which is what a finger dragging a frame
    /// is expected to do.
    static func moved(
        _ crop: PhotoTransforms.Crop, byX dx: Double, y dy: Double
    ) -> PhotoTransforms.Crop {
        guard dx.isFinite, dy.isFinite else { return crop }
        return PhotoTransforms.Crop(
            x: min(max(crop.x + dx, 0), max(0, 1 - crop.w)),
            y: min(max(crop.y + dy, 0), max(0, 1 - crop.h)),
            w: crop.w,
            h: crop.h
        )
    }

    /// Which corner of the crop a handle is.
    enum Corner: CaseIterable, Sendable {
        case topLeft, topRight, bottomLeft, bottomRight

        var movesLeftEdge: Bool { self == .topLeft || self == .bottomLeft }
        var movesTopEdge: Bool { self == .topLeft || self == .topRight }
    }

    /// Drag one corner of a crop.
    ///
    /// With `ratio` set the rectangle keeps that aspect — the dragged corner
    /// leads and the other edge follows, since letting both edges chase the
    /// finger would make the crop jitter. The opposite corner is always
    /// pinned, so a resize never walks the crop across the image.
    ///
    /// `imageWidth`/`imageHeight` are needed only for a locked ratio: an
    /// aspect is of pixels, and normalized coordinates are not square.
    static func resized(
        _ crop: PhotoTransforms.Crop,
        corner: Corner,
        byX dx: Double,
        y dy: Double,
        ratio: PhotoTransforms.AspectRatio? = nil,
        imageWidth: Double = 1,
        imageHeight: Double = 1
    ) -> PhotoTransforms.Crop {
        guard dx.isFinite, dy.isFinite else { return crop }

        // The pinned corner, in normalized coordinates.
        let anchorX = corner.movesLeftEdge ? crop.x + crop.w : crop.x
        let anchorY = corner.movesTopEdge ? crop.y + crop.h : crop.y
        let draggedX = min(max((corner.movesLeftEdge ? crop.x : crop.x + crop.w) + dx, 0), 1)
        let draggedY = min(max((corner.movesTopEdge ? crop.y : crop.y + crop.h) + dy, 0), 1)

        var width = abs(draggedX - anchorX)
        var height = abs(draggedY - anchorY)

        let availableWidth = corner.movesLeftEdge ? anchorX : 1 - anchorX
        let availableHeight = corner.movesTopEdge ? anchorY : 1 - anchorY

        if let ratio, imageWidth > 0, imageHeight > 0 {
            // width/height in normalized units for the wanted pixel aspect.
            let relative = ratio.value / (imageWidth / imageHeight)
            // Follow whichever axis the finger moved further along, so the
            // gesture leads and the other edge is derived.
            if abs(dx) >= abs(dy) {
                height = width / relative
            } else {
                width = height * relative
            }
            // A locked ratio is scaled as a whole — clamping the two edges
            // separately would silently unlock it.
            let grow = max(
                1,
                max(
                    Limits.minCropFraction / max(width, 1e-9),
                    Limits.minCropFraction / max(height, 1e-9)
                )
            )
            width *= grow
            height *= grow
            let shrink = min(
                1,
                min(
                    width > 0 ? availableWidth / width : 1,
                    height > 0 ? availableHeight / height : 1
                )
            )
            width *= shrink
            height *= shrink
        } else {
            width = min(max(width, Limits.minCropFraction), max(availableWidth, 1e-9))
            height = min(max(height, Limits.minCropFraction), max(availableHeight, 1e-9))
        }

        return PhotoTransforms.Crop(
            x: corner.movesLeftEdge ? anchorX - width : anchorX,
            y: corner.movesTopEdge ? anchorY - height : anchorY,
            w: width,
            h: height
        )
    }

    /// A normalized crop as a pixel rectangle in an image of this size.
    static func pixelRect(
        _ crop: PhotoTransforms.Crop, imageWidth: Double, imageHeight: Double
    ) -> CGRect {
        CGRect(
            x: (crop.x * imageWidth).rounded(),
            y: (crop.y * imageHeight).rounded(),
            width: (crop.w * imageWidth).rounded(),
            height: (crop.h * imageHeight).rounded()
        )
    }

    // MARK: - Rotation

    /// Turn a quarter turn clockwise. Rotation is applied *after* the crop, so
    /// the crop rectangle stays exactly where it was.
    static func rotatedClockwise(_ rotation: Int) -> Int {
        (((rotation + 90) % 360) + 360) % 360
    }

    // MARK: - Tone

    /// The tone curve a recipe applies, as the phone can evaluate it.
    ///
    /// Straight from `renderPhotoWithRecipe`: exposure and contrast collapse
    /// into one line, the black/white points into a second, and gamma follows
    /// as an exponent. Keeping the same three steps in the same order is what
    /// makes the live preview agree with the file the server later renders.
    struct ToneCurve: Equatable, Sendable {
        /// Exposure × contrast, on 0…1 values.
        var slope: Double
        var intercept: Double
        /// The black/white-point remap, already folded in.
        var levelsSlope: Double
        var levelsIntercept: Double
        /// The exponent applied last: `out = in^exponent`, i.e. 1/gamma.
        var exponent: Double

        static let identity = ToneCurve(
            slope: 1, intercept: 0, levelsSlope: 1, levelsIntercept: 0, exponent: 1
        )

        var isIdentity: Bool { self == .identity }

        /// One channel value through the curve, clipped like the renderer.
        func apply(_ value: Double) -> Double {
            var out = value * slope + intercept
            out = out * levelsSlope + levelsIntercept
            out = min(max(out, 0), 1)
            guard exponent != 1 else { return out }
            return pow(out, exponent)
        }
    }

    static func toneCurve(for recipe: Recipe) -> ToneCurve {
        var curve = ToneCurve.identity

        let exposure = recipe.exposure.isFinite ? recipe.exposure : 0
        let contrast = recipe.contrast.isFinite ? recipe.contrast : 0
        let contrastFactor = 1 + contrast
        curve.slope = pow(2, exposure) * contrastFactor
        // The renderer pivots contrast around 128 of 255 — mid-grey.
        curve.intercept = (1 - contrastFactor) * (128.0 / 255.0)

        let black = recipe.blackPoint ?? 0
        let white = recipe.whitePoint ?? 1
        // A window narrower than a single level is not a stretch, it is a
        // division by nearly zero; the renderer skips it and so does this.
        if white - black > 1.0 / 255.0, black.isFinite, white.isFinite {
            curve.levelsSlope = 1 / (white - black)
            curve.levelsIntercept = -black * curve.levelsSlope
        }

        let gamma = recipe.gamma.isFinite ? recipe.gamma : 1
        if abs(gamma - 1) > 0.001 {
            // The server clamps gamma to sharp's 1…3 window; a preview that
            // ignored that would promise an edit the file will not have.
            curve.exponent = 1 / min(max(gamma, 1), 3)
        }
        return curve
    }

    // MARK: - Requests

    /// Body for `PUT /photos/:id/transforms`.
    ///
    /// Every field is sent, including the nulls: leaving one out means "keep
    /// what is stored", which is not what clearing a crop is meant to do.
    struct UpsertRequest: Encodable, Sendable {
        let crop: PhotoTransforms.Crop?
        let rotation: Int
        let exposure: Double
        let contrast: Double
        let gamma: Double
        let white_point: Double?
        let black_point: Double?

        init(_ recipe: Recipe) {
            let clamped = PhotoRecipe.clampedForSave(recipe)
            crop = clamped.crop
            rotation = clamped.rotation
            exposure = clamped.exposure
            contrast = clamped.contrast
            gamma = clamped.gamma
            white_point = clamped.whitePoint
            black_point = clamped.blackPoint
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            // encodeIfPresent would drop the nulls, and a dropped null reads
            // as „unchanged" to the server rather than „cleared".
            try container.encode(crop, forKey: .crop)
            try container.encode(rotation, forKey: .rotation)
            try container.encode(exposure, forKey: .exposure)
            try container.encode(contrast, forKey: .contrast)
            try container.encode(gamma, forKey: .gamma)
            try container.encode(white_point, forKey: .white_point)
            try container.encode(black_point, forKey: .black_point)
        }

        enum CodingKeys: String, CodingKey {
            case crop, rotation, exposure, contrast, gamma, white_point, black_point
        }
    }

    /// Body for `POST /photos/:id/transforms/auto-levels`. The crop goes with
    /// it: auto-levels reads the pixels that will actually be kept, so
    /// levelling a photo and then cropping the sky out gives a different
    /// answer than the other way round.
    struct AutoLevelsRequest: Encodable, Sendable {
        let crop: PhotoTransforms.Crop?
    }

    /// What auto-levels answers. It does **not** persist — the values land in
    /// the sliders and the user saves, or doesn't.
    struct AutoLevelsResult: Decodable, Sendable {
        let exposure: Double
        let contrast: Double
        let gamma: Double
    }

    /// Auto-levels applied to a recipe: tone replaced, framing untouched.
    static func applying(_ result: AutoLevelsResult, to recipe: Recipe) -> Recipe {
        var out = recipe
        out.exposure = result.exposure
        out.contrast = result.contrast
        out.gamma = result.gamma
        return out
    }
}
