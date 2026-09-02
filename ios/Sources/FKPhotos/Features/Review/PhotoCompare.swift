import CoreGraphics
import Foundation

/// Comparing two shots of the same moment: which one is worth keeping.
///
/// A port of the web's `frontend/src/utils/compareZoom.ts`, which drives
/// `PhotoCompareView.vue`. iOS already has the *confirmation* half of that
/// screen (`ReviewSelectionSheet`, from #761) — what was missing is the
/// comparison itself, and the part of it that actually decides anything is
/// this: zooming both photos to the same face at the same on-screen size, so
/// the difference in sharpness is visible rather than guessed.
///
/// Everything here is pure geometry.
enum PhotoCompare {

    // MARK: - Inputs

    /// A face rectangle in normalized image coordinates — `0…1` of the
    /// photo's width and height.
    struct BBox: Equatable, Sendable {
        let x: Double
        let y: Double
        let width: Double
        let height: Double

        var centerX: Double { x + width / 2 }
        var centerY: Double { y + height / 2 }
        var area: Double { width * height }

        init(x: Double, y: Double, width: Double, height: Double) {
            self.x = x
            self.y = y
            self.width = width
            self.height = height
        }

        init(_ bbox: FaceBBox) {
            self.init(x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height)
        }

        /// Detectors occasionally run a box a little past the edge, so the
        /// bounds are checked with slack rather than exactly.
        var isUsable: Bool {
            guard [x, y, width, height].allSatisfy({ $0.isFinite }) else { return false }
            guard width > 0, height > 0 else { return false }
            return x >= -0.1 && x <= 1.1 && y >= -0.1 && y <= 1.1
        }
    }

    /// Where a photo is drawn and how big it actually is.
    struct Viewport: Equatable, Sendable {
        /// The area the photo is drawn into, in points.
        let width: Double
        let height: Double
        /// The photo's own pixel dimensions.
        let photoWidth: Double
        let photoHeight: Double

        var isUsable: Bool {
            let values = [width, height, photoWidth, photoHeight]
            return values.allSatisfy { $0.isFinite && $0 > 0 }
        }
    }

    /// One face, as far as picking one is concerned.
    struct Candidate: Sendable {
        let bbox: BBox
        let personId: Int?
        let quality: Double?
        let ignored: Bool

        init(bbox: BBox, personId: Int? = nil, quality: Double? = nil, ignored: Bool = false) {
            self.bbox = bbox
            self.personId = personId
            self.quality = quality
            self.ignored = ignored
        }

        init(_ face: Face) {
            self.init(
                bbox: BBox(face.bbox),
                personId: face.person_id,
                quality: face.quality,
                ignored: face.ignored
            )
        }
    }

    // MARK: - Defaults

    /// How much of the smaller viewport axis a face should fill once zoomed.
    static let defaultTargetFraction: Double = 0.4
    static let defaultMinZoom: Double = 1
    static let defaultMaxZoom: Double = 6

    // MARK: - Geometry

    /// Where the photo actually sits inside its viewport when scaled to fit.
    /// Letterboxed on one axis whenever the aspect ratios differ, which is
    /// why a tap position cannot be read as an image coordinate directly.
    struct ContainedRect: Equatable, Sendable {
        let width: Double
        let height: Double
        let offsetX: Double
        let offsetY: Double
    }

    static func containedRect(in viewport: Viewport) -> ContainedRect {
        let imageAspect = viewport.photoWidth / viewport.photoHeight
        let containerAspect = viewport.width / viewport.height
        let width: Double
        let height: Double
        if imageAspect > containerAspect {
            width = viewport.width
            height = viewport.width / imageAspect
        } else {
            height = viewport.height
            width = viewport.height * imageAspect
        }
        return ContainedRect(
            width: width,
            height: height,
            offsetX: (viewport.width - width) / 2,
            offsetY: (viewport.height - height) / 2
        )
    }

    // MARK: - Zoom

    /// How to draw a photo so one face sits centred and large.
    ///
    /// Written for SwiftUI's composition order rather than CSS's: apply
    /// `.scaleEffect(zoom)` about the centre, then `.offset(offset)`. The web
    /// scales *after* translating and so divides by the zoom where this
    /// multiplies; both land the face in the same place.
    struct Zoom: Equatable, Sendable {
        let zoom: Double
        /// Points to shift the scaled photo by, to bring the face to the centre.
        let offset: CGSize
        /// How big the face ends up on screen — what the two photos are
        /// matched on.
        let faceScreen: CGSize
    }

    /// Zoom a photo so `bbox` is centred.
    ///
    /// Without an explicit `zoom`, one is derived so the face fills
    /// `targetFraction` of the smaller viewport axis. Always clamped, so a
    /// tiny face in a large photo cannot blow up past `maxZoom`.
    static func zoom(
        to bbox: BBox,
        in viewport: Viewport,
        zoom explicitZoom: Double? = nil,
        targetFraction: Double = defaultTargetFraction,
        minZoom: Double = defaultMinZoom,
        maxZoom: Double = defaultMaxZoom
    ) -> Zoom? {
        guard bbox.isUsable, viewport.isUsable else { return nil }

        let rect = containedRect(in: viewport)
        let faceCenterX = rect.offsetX + bbox.centerX * rect.width
        let faceCenterY = rect.offsetY + bbox.centerY * rect.height
        let facePointWidth = bbox.width * rect.width
        let facePointHeight = bbox.height * rect.height
        guard facePointWidth > 0, facePointHeight > 0 else { return nil }

        var scale: Double
        if let explicitZoom, explicitZoom.isFinite {
            scale = explicitZoom
        } else {
            let target = targetFraction * min(viewport.width, viewport.height)
            scale = min(target / facePointWidth, target / facePointHeight)
        }
        scale = min(max(scale, minZoom), maxZoom)

        // Scaling about the viewport centre moves a point at `p` to
        // `c + (p - c) * scale`, so the shift that brings it back to `c` is
        // `(c - p) * scale`.
        let centerX = viewport.width / 2
        let centerY = viewport.height / 2
        return Zoom(
            zoom: scale,
            offset: CGSize(
                width: (centerX - faceCenterX) * scale,
                height: (centerY - faceCenterY) * scale
            ),
            faceScreen: CGSize(
                width: scale * facePointWidth,
                height: scale * facePointHeight
            )
        )
    }

    /// Zoom two photos so their faces come out the **same size on screen**.
    ///
    /// This is the whole point of the comparison: at matched size the sharper
    /// shot is obvious, where two independently-zoomed faces are not
    /// comparable at all. Each photo's own zoom is solved first, and the
    /// smaller resulting face wins — going the other way would push the other
    /// face past its viewport.
    static func syncedZoom(
        _ first: (bbox: BBox, viewport: Viewport),
        _ second: (bbox: BBox, viewport: Viewport),
        targetFraction: Double = defaultTargetFraction,
        minZoom: Double = defaultMinZoom,
        maxZoom: Double = defaultMaxZoom
    ) -> (first: Zoom?, second: Zoom?) {
        let a = zoom(
            to: first.bbox, in: first.viewport,
            targetFraction: targetFraction, minZoom: minZoom, maxZoom: maxZoom
        )
        let b = zoom(
            to: second.bbox, in: second.viewport,
            targetFraction: targetFraction, minZoom: minZoom, maxZoom: maxZoom
        )
        guard let a, let b else { return (a, b) }

        let target = min(a.faceScreen.width, b.faceScreen.width)
        let rectA = containedRect(in: first.viewport)
        let rectB = containedRect(in: second.viewport)
        let widthA = first.bbox.width * rectA.width
        let widthB = second.bbox.width * rectB.width
        guard widthA > 0, widthB > 0 else { return (a, b) }

        return (
            zoom(
                to: first.bbox, in: first.viewport, zoom: target / widthA,
                targetFraction: targetFraction, minZoom: minZoom, maxZoom: maxZoom
            ),
            zoom(
                to: second.bbox, in: second.viewport, zoom: target / widthB,
                targetFraction: targetFraction, minZoom: minZoom, maxZoom: maxZoom
            )
        )
    }

    // MARK: - Picking a face

    /// The face to zoom to when the user has not pointed at one.
    ///
    /// A named face wins over an unnamed one by a wide margin — if the user
    /// has tagged someone, that is who the photo is of. Among equals, the
    /// better-quality and larger face wins.
    static func primaryFace(in faces: [Candidate]) -> Candidate? {
        let usable = faces.filter { !$0.ignored && $0.bbox.isUsable }
        guard !usable.isEmpty else { return nil }
        return usable.max { lhs, rhs in score(lhs) < score(rhs) }
    }

    private static func score(_ candidate: Candidate) -> Double {
        (candidate.personId != nil ? 1000 : 0)
            + (candidate.quality ?? 0) * 10
            + candidate.bbox.area
    }

    /// The largest face belonging to one person, for lining the same person up
    /// across both photos.
    static func face(forPerson personId: Int, in faces: [Candidate]) -> Candidate? {
        faces
            .filter { !$0.ignored && $0.personId == personId && $0.bbox.isUsable }
            .max { $0.bbox.area < $1.bbox.area }
    }

    /// The face the user pointed at, in a photo with several.
    ///
    /// A tap inside a face picks it — the **tightest** one when boxes overlap,
    /// which is almost always the face actually pointed at rather than the
    /// group behind it. A tap near one picks the nearest, but only within
    /// `nearRadius`. A tap on empty background falls back to the primary face
    /// rather than doing nothing.
    static func face(
        at point: CGPoint,
        in faces: [Candidate],
        nearRadius: Double = 0.15
    ) -> Candidate? {
        let x = Double(point.x), y = Double(point.y)
        guard x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y) else {
            return primaryFace(in: faces)
        }
        let usable = faces.filter { !$0.ignored && $0.bbox.isUsable }
        guard !usable.isEmpty else { return nil }

        let containing = usable.filter {
            x >= $0.bbox.x && x <= $0.bbox.x + $0.bbox.width
                && y >= $0.bbox.y && y <= $0.bbox.y + $0.bbox.height
        }
        if let tightest = containing.min(by: { $0.bbox.area < $1.bbox.area }) {
            return tightest
        }

        let nearest = usable.min {
            distance(from: $0.bbox, to: x, y) < distance(from: $1.bbox, to: x, y)
        }
        if let nearest, distance(from: nearest.bbox, to: x, y) <= nearRadius {
            return nearest
        }
        return primaryFace(in: faces)
    }

    private static func distance(from bbox: BBox, to x: Double, _ y: Double) -> Double {
        (pow(bbox.centerX - x, 2) + pow(bbox.centerY - y, 2)).squareRoot()
    }

    /// Where a tap landed, as image coordinates.
    ///
    /// Nil when it landed on a letterbox stripe rather than the photo — there
    /// is no face there to have meant.
    static func imageCoordinates(
        of point: CGPoint,
        in viewport: Viewport
    ) -> CGPoint? {
        guard viewport.isUsable,
              Double(point.x).isFinite, Double(point.y).isFinite else { return nil }
        let rect = containedRect(in: viewport)
        let relativeX = Double(point.x) - rect.offsetX
        let relativeY = Double(point.y) - rect.offsetY
        guard relativeX >= 0, relativeX <= rect.width,
              relativeY >= 0, relativeY <= rect.height else { return nil }
        return CGPoint(x: relativeX / rect.width, y: relativeY / rect.height)
    }
}
