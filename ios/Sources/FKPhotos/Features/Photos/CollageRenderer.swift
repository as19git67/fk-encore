import CoreGraphics
import Foundation
import UIKit

/// Drawing a collage to an image, and working out how big that image should be.
///
/// The web renders its canvas in the browser and uploads the JPEG as an
/// ordinary photo — there is no collage endpoint (#1020). This is the same
/// move on the phone. The cell rectangles and the per-photo crop come from
/// `CollageLayouts`, shared with the web; what is here is the pixel geometry
/// and the draw.
///
/// The size maths is separated from the drawing so it can be tested without a
/// graphics context.
enum CollageRenderer {

    /// The longest edge of a rendered collage, in pixels — the web's
    /// `EXPORT_LONG_EDGE`, so a collage is the same size wherever it was made.
    ///
    /// A 4000 × 4000 canvas is 64 MB of pixels while it is drawn, well within
    /// a phone's budget for a moment's work.
    static let maxEdge: Double = 4000

    /// The white gap between cells, as a fraction of the long edge — the
    /// web's `GAP_FRACTION`. Every cell gives up half of it on each side, so
    /// the outer border is half as wide as the seam between two photos.
    static let gapFraction: Double = 0.006

    /// JPEG quality of the saved and shared collage, as on the web.
    static let jpegQuality: CGFloat = 0.92

    /// The gap in pixels for a canvas of this size.
    static func gap(for canvas: CGSize) -> Double {
        (Double(max(canvas.width, canvas.height)) * gapFraction).rounded()
    }

    /// The pixel size of a canvas with this aspect.
    ///
    /// The longer side gets `maxEdge`; the shorter follows from the aspect, so
    /// a portrait layout is as tall as a landscape one is wide. Never smaller
    /// than one pixel on either axis — a degenerate aspect would otherwise
    /// produce a canvas nothing can be drawn into.
    static func canvasSize(aspect: Double, maxEdge: Double = maxEdge) -> CGSize {
        guard aspect.isFinite, aspect > 0, maxEdge > 0 else {
            return CGSize(width: maxEdge, height: maxEdge)
        }
        let width = aspect >= 1 ? maxEdge : maxEdge * aspect
        let height = aspect >= 1 ? maxEdge / aspect : maxEdge
        return CGSize(width: max(1, width.rounded()), height: max(1, height.rounded()))
    }

    /// Where a cell lands on the canvas, in pixels.
    ///
    /// Rounded outward — a cell's edges are grown to whole pixels rather than
    /// truncated, so neighbouring cells overlap by a fraction of a pixel
    /// instead of leaving a hairline of background between them.
    ///
    /// With a `gap`, the cell is then inset by half of it on every side, as
    /// the web draws it (`dx = x + gap/2`, `dw = w − gap`).
    static func destinationRect(
        for cell: CollageLayouts.Cell,
        canvas: CGSize,
        gap: Double = 0
    ) -> CGRect {
        let left = (cell.x * Double(canvas.width)).rounded(.down)
        let top = (cell.y * Double(canvas.height)).rounded(.down)
        let right = ((cell.x + cell.width) * Double(canvas.width)).rounded(.up)
        let bottom = ((cell.y + cell.height) * Double(canvas.height)).rounded(.up)
        let rect = CGRect(x: left, y: top, width: right - left, height: bottom - top)
        guard gap > 0 else { return rect }
        return rect.insetBy(dx: CGFloat(gap / 2), dy: CGFloat(gap / 2))
    }

    /// One photo, ready to be drawn.
    struct Tile {
        let image: UIImage
        /// The photo's focal point, so a face is not cropped away.
        let focal: CGPoint?

        init(image: UIImage, focal: CGPoint? = nil) {
            self.image = image
            self.focal = focal
        }
    }

    /// Draw the collage.
    ///
    /// Tiles fill the layout's cells in order; a layout with more cells than
    /// tiles leaves the remainder as background rather than failing, so a
    /// photo that could not be downloaded costs its cell, not the collage.
    /// Returns nil when there is nothing to draw.
    static func render(
        layout: CollageLayouts.Layout,
        tiles: [Tile],
        overlays: [CollageText.Overlay] = [],
        background: UIColor = .white,
        maxEdge: Double = maxEdge
    ) -> UIImage? {
        guard !layout.cells.isEmpty, !tiles.isEmpty else { return nil }
        let canvas = canvasSize(aspect: layout.aspect, maxEdge: maxEdge)

        let format = UIGraphicsImageRendererFormat.default()
        // The canvas is already in pixels; a scale above 1 would multiply it
        // again and blow the memory budget for no visible gain.
        format.scale = 1
        format.opaque = true

        return UIGraphicsImageRenderer(size: canvas, format: format).image { context in
            background.setFill()
            context.fill(CGRect(origin: .zero, size: canvas))

            let seam = Self.gap(for: canvas)
            for (index, cell) in layout.cells.enumerated() {
                guard index < tiles.count else { break }
                let tile = tiles[index]
                let destination = destinationRect(for: cell, canvas: canvas, gap: seam)
                guard destination.width > 0, destination.height > 0 else { continue }
                draw(tile, into: destination, context: context.cgContext)
            }

            // Captions go on last, over every cell: a caption is placed
            // against the whole picture, not against one photo in it.
            for overlay in overlays {
                draw(overlay, canvas: canvas)
            }
        }
    }

    /// The font a caption is drawn in.
    ///
    /// Bold and system, matching the web's bold Inter closely enough that the
    /// same caption wraps at roughly the same word. The exact metrics differ
    /// between the two, which is why the wrap is measured rather than assumed.
    static func font(ofSize size: Double) -> UIFont {
        UIFont.systemFont(ofSize: CGFloat(size), weight: .bold)
    }

    /// Measure a line as it will be drawn.
    static func measure(_ line: String, size: Double) -> Double {
        guard !line.isEmpty else { return 0 }
        return Double((line as NSString).size(
            withAttributes: [.font: font(ofSize: size)]
        ).width)
    }

    /// Draw one caption: a dark outline for legibility over any photo, then
    /// the chosen fill on top.
    private static func draw(_ overlay: CollageText.Overlay, canvas: CGSize) {
        guard let block = CollageText.block(
            for: overlay, canvas: canvas, measure: measure(_:size:)
        ) else { return }

        let uiFont = font(ofSize: block.fontSize)
        let fill = CollageText.color(fromHex: overlay.colorHex) ?? .white
        // `strokeWidth` is a percentage of the font size, and a negative one
        // means "stroke *and* fill" — a positive value would draw the outline
        // only, leaving hollow letters.
        let strokePercent = -100 * CollageText.strokeWidth(fontSize: block.fontSize)
            / max(block.fontSize, 1)

        let attributes: [NSAttributedString.Key: Any] = [
            .font: uiFont,
            .foregroundColor: fill,
            .strokeColor: UIColor.black.withAlphaComponent(0.7),
            .strokeWidth: strokePercent,
        ]

        for (index, line) in block.lines.enumerated() where !line.isEmpty {
            let width = measure(line, size: block.fontSize)
            let left: Double
            switch overlay.align {
            case .left: left = block.anchorX
            case .right: left = block.anchorX - width
            case .center: left = block.centerX - width / 2
            }
            (line as NSString).draw(
                at: CGPoint(x: left, y: block.lineTop(index)),
                withAttributes: attributes
            )
        }
    }

    /// Draw one photo so it fills its cell, cropping what does not fit.
    private static func draw(_ tile: Tile, into destination: CGRect, context: CGContext) {
        guard let cgImage = tile.image.cgImage else { return }
        let pixelWidth = Double(cgImage.width)
        let pixelHeight = Double(cgImage.height)
        let source = CollageLayouts.coverCrop(
            photoWidth: pixelWidth,
            photoHeight: pixelHeight,
            destinationAspect: Double(destination.width / destination.height),
            focal: tile.focal
        )
        let cropRect = CGRect(
            x: source.x, y: source.y, width: source.width, height: source.height
        )
        guard source.width > 0, source.height > 0,
              let cropped = cgImage.cropping(to: cropRect) else { return }

        context.saveGState()
        context.clip(to: destination)
        // CoreGraphics draws bottom-up, so a straight `draw` would flip the
        // photo. Flipping the cell's own coordinate space keeps it upright.
        context.translateBy(x: 0, y: destination.midY * 2)
        context.scaleBy(x: 1, y: -1)
        context.draw(cropped, in: destination)
        context.restoreGState()
    }

    // MARK: - Upload metadata

    /// A collage takes the capture date of its **newest** source plus one
    /// second, so it sorts directly after the photos it was made from rather
    /// than at "now" — the web's `getCollageDate` in `CollageDialog.vue`,
    /// sent the same way through `X-Date-Taken`.
    ///
    /// The wall-clock components are carried over literally and the second is
    /// added in UTC: the server discards any offset, as it does for EXIF, so
    /// converting through the device's time zone could only skew it.
    ///
    /// Nil when no source has a date to inherit, in which case the server
    /// falls back to the file's own EXIF.
    static func inheritedDate(from photos: [PhotoWithCuration]) -> String? {
        let newest = photos
            .compactMap { $0.taken_at }
            .compactMap(wallClock(_:))
            .max()
        guard let newest else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: newest.addingTimeInterval(1))
    }

    /// `YYYY-MM-DD[T ]HH:MM[:SS]` read as wall-clock time on a UTC calendar;
    /// fractions and any offset after it are ignored, as on the web.
    static func wallClock(_ raw: String) -> Date? {
        let chars = Array(raw)
        func number(_ start: Int, _ length: Int) -> Int? {
            guard start + length <= chars.count else { return nil }
            let digits = chars[start..<start + length]
            guard digits.allSatisfy(\.isASCII), digits.allSatisfy(\.isNumber) else { return nil }
            return Int(String(digits))
        }
        func char(_ index: Int, in set: String) -> Bool {
            index < chars.count && set.contains(chars[index])
        }
        guard let year = number(0, 4), char(4, in: "-"),
              let month = number(5, 2), char(7, in: "-"),
              let day = number(8, 2), char(10, in: "T "),
              let hour = number(11, 2), char(13, in: ":"),
              let minute = number(14, 2)
        else { return nil }
        let second = char(16, in: ":") ? number(17, 2) ?? 0 : 0

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar.date(from: DateComponents(
            year: year, month: month, day: day,
            hour: hour, minute: minute, second: second
        ))
    }

    /// The filename a collage is uploaded under.
    static func filename(date: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return "collage-\(formatter.string(from: date)).jpg"
    }
}
