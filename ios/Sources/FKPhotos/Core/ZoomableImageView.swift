import SwiftUI
import UIKit

/// UIScrollView-based photo viewer with pinch-to-zoom and double-tap zoom.
/// At zoom 1x the UIScrollView has no scrollable content, so horizontal swipes
/// pass through to the parent TabView page switcher automatically.
///
/// Two overlays live *inside* the image view so zoom and pan carry them for
/// free: the yellow face box, and — in text mode — the recognised text laid
/// over the photo as selectable, invisible text (#1029). Both are positioned
/// with the same aspect-fit letterbox math.
struct ZoomableImageView: UIViewRepresentable {
    let image: UIImage
    let faceBBox: FaceBBox?
    /// Recognised lines, already mapped into *this* image's view (cropped and
    /// turned like the pixels were) — see `PhotoOcrLayout.lines`.
    let textLines: [PhotoOcrLayout.Line]
    /// When true the lines show themselves and take touches, so a long press
    /// selects a word on the sign; off, they are inert and invisible.
    let textMode: Bool

    init(
        image: UIImage,
        faceBBox: FaceBBox? = nil,
        textLines: [PhotoOcrLayout.Line] = [],
        textMode: Bool = false
    ) {
        self.image = image
        self.faceBBox = faceBBox
        self.textLines = textLines
        self.textMode = textMode
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> ZoomScrollView {
        let sv = ZoomScrollView()
        sv.delegate = context.coordinator
        sv.minimumZoomScale = 1
        sv.maximumZoomScale = 5
        sv.showsHorizontalScrollIndicator = false
        sv.showsVerticalScrollIndicator = false
        sv.backgroundColor = .systemBackground
        sv.contentInsetAdjustmentBehavior = .never
        sv.bouncesZoom = true

        let iv = UIImageView(image: image)
        iv.contentMode = .scaleAspectFit
        iv.backgroundColor = .systemBackground
        // Off by default on an image view; the text lines need touches to
        // reach them. The face box opts out on its own.
        iv.isUserInteractionEnabled = true
        sv.addSubview(iv)
        context.coordinator.imageView = iv

        if let bbox = faceBBox {
            let bv = UIView()
            bv.layer.borderColor = UIColor.yellow.cgColor
            bv.layer.borderWidth = 2
            bv.backgroundColor = .clear
            bv.isUserInteractionEnabled = false
            iv.addSubview(bv)
            context.coordinator.bboxView = bv
            context.coordinator.faceBBox = bbox
        }

        let tl = UIView()
        tl.backgroundColor = .clear
        iv.addSubview(tl)
        context.coordinator.textLayer = tl
        context.coordinator.textLines = textLines
        context.coordinator.textMode = textMode
        context.coordinator.rebuildTextLayer()

        sv.onLayoutSubviews = { [weak c = context.coordinator] in
            c?.updateBBoxPosition()
            c?.layoutTextLayer()
        }

        let doubleTap = UITapGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleDoubleTap(_:))
        )
        doubleTap.numberOfTapsRequired = 2
        sv.addGestureRecognizer(doubleTap)

        return sv
    }

    func updateUIView(_ sv: ZoomScrollView, context: Context) {
        let c = context.coordinator
        if let iv = c.imageView, iv.image !== image {
            iv.image = image
            sv.setZoomScale(1, animated: false)
            sv.setNeedsLayout()
        }
        if c.textLines != textLines || c.textMode != textMode {
            c.textLines = textLines
            c.textMode = textMode
            c.rebuildTextLayer()
            c.layoutTextLayer()
        }
    }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        weak var imageView: UIImageView?
        weak var bboxView: UIView?
        var faceBBox: FaceBBox?
        weak var textLayer: UIView?
        var textLines: [PhotoOcrLayout.Line] = []
        var textMode = false

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

        func scrollViewDidZoom(_ scrollView: UIScrollView) {
            guard let iv = imageView else { return }
            let b = scrollView.bounds.size
            var f = iv.frame
            // Center the image view when smaller than the scroll view bounds
            f.origin.x = f.width  < b.width  ? (b.width  - f.width)  / 2 : 0
            f.origin.y = f.height < b.height ? (b.height - f.height) / 2 : 0
            iv.frame = f
        }

        /// The rectangle the aspect-fitted image occupies inside the image
        /// view's own bounds — the frame every overlay is expressed in.
        private func renderedImageRect() -> CGRect? {
            guard let iv = imageView,
                  let imgSize = iv.image?.size,
                  imgSize.width > 0, imgSize.height > 0,
                  iv.bounds.width > 0, iv.bounds.height > 0 else { return nil }
            let ar = imgSize.width / imgSize.height
            let viewAR = iv.bounds.width / iv.bounds.height
            let rW: CGFloat = ar > viewAR ? iv.bounds.width : iv.bounds.height * ar
            let rH: CGFloat = ar > viewAR ? iv.bounds.width / ar : iv.bounds.height
            return CGRect(
                x: (iv.bounds.width - rW) / 2,
                y: (iv.bounds.height - rH) / 2,
                width: rW,
                height: rH
            )
        }

        /// Position the bbox view within the image view's local coordinate space,
        /// accounting for aspect-fit letterboxing. Called when bounds change; zoom/pan
        /// is handled automatically because the bbox is a subview of the image view.
        func updateBBoxPosition() {
            guard let bbox = faceBBox, let bv = bboxView, let r = renderedImageRect() else { return }
            bv.frame = CGRect(
                x: r.minX + CGFloat(bbox.x) * r.width,
                y: r.minY + CGFloat(bbox.y) * r.height,
                width: max(CGFloat(bbox.width) * r.width, 4),
                height: max(CGFloat(bbox.height) * r.height, 4)
            )
        }

        // MARK: Text layer

        /// One selectable text view per line. Invisible text with the
        /// platform's own selection is what makes long-press, drag handles and
        /// the Copy menu work without any of it being re-implemented.
        func rebuildTextLayer() {
            guard let tl = textLayer else { return }
            tl.subviews.forEach { $0.removeFromSuperview() }
            tl.isUserInteractionEnabled = textMode
            for line in textLines {
                let tv = UITextView()
                tv.text = line.text
                tv.isEditable = false
                tv.isScrollEnabled = false
                tv.isSelectable = true
                tv.textContainerInset = .zero
                tv.textContainer.lineFragmentPadding = 0
                tv.textContainer.maximumNumberOfLines = 1
                tv.textContainer.lineBreakMode = .byClipping
                tv.textColor = .clear
                tv.tintColor = .systemBlue
                tv.layer.cornerRadius = 2
                // Anchored at the top-left corner, where the quad is anchored,
                // so the rotation turns the box about that corner.
                tv.layer.anchorPoint = CGPoint(x: 0, y: 0)
                tv.isUserInteractionEnabled = textMode
                styleTextView(tv, confidence: line.confidence)
                tl.addSubview(tv)
            }
        }

        private func styleTextView(_ tv: UITextView, confidence: Double) {
            guard textMode else {
                tv.backgroundColor = .clear
                tv.layer.borderWidth = 0
                return
            }
            // The lines announce themselves in text mode; a line the detector
            // was unsure about is shown fainter, so a wrong reading of the
            // brickwork does not look as certain as the sign next to it.
            let sure = confidence >= 0.7
            tv.backgroundColor = UIColor.systemYellow.withAlphaComponent(sure ? 0.22 : 0.1)
            tv.layer.borderColor = UIColor.systemYellow.withAlphaComponent(sure ? 0.45 : 0.25).cgColor
            tv.layer.borderWidth = 1
        }

        /// Size and place every line inside the rendered image rectangle: the
        /// font is sized to the box height, the text is measured at that font
        /// and stretched horizontally to the box width, then the whole thing
        /// is turned by the line's angle about its top-left corner.
        func layoutTextLayer() {
            guard let tl = textLayer, let iv = imageView, let r = renderedImageRect() else { return }
            tl.frame = iv.bounds
            for (tv, line) in zip(tl.subviews, textLines) {
                guard let tv = tv as? UITextView else { continue }
                let boxW = CGFloat(line.width) * r.width
                let boxH = CGFloat(line.height) * r.height
                let font = UIFont.systemFont(ofSize: max(6, boxH * 0.8))
                tv.font = font
                let measured = (line.text as NSString).size(withAttributes: [.font: font]).width
                let sx = PhotoOcrLayout.fitScaleX(measuredWidth: Double(measured), targetWidth: Double(boxW))
                tv.transform = .identity
                tv.bounds = CGRect(x: 0, y: 0, width: max(measured, 1), height: boxH)
                tv.layer.position = CGPoint(
                    x: r.minX + CGFloat(line.x) * r.width,
                    y: r.minY + CGFloat(line.y) * r.height
                )
                // Scale first, then rotate — the stretch happens along the
                // text, not along the screen's x axis.
                tv.transform = CGAffineTransform(rotationAngle: CGFloat(line.angle))
                    .scaledBy(x: CGFloat(sx), y: 1)
            }
        }

        @objc func handleDoubleTap(_ gr: UITapGestureRecognizer) {
            guard let sv = gr.view as? UIScrollView else { return }
            if sv.zoomScale > sv.minimumZoomScale {
                sv.setZoomScale(sv.minimumZoomScale, animated: true)
            } else {
                let p = gr.location(in: imageView)
                sv.zoom(to: CGRect(x: p.x - 50, y: p.y - 50, width: 100, height: 100),
                        animated: true)
            }
        }
    }
}

/// UIScrollView subclass that resizes its image view to fill bounds on layout.
/// Resets zoom only when the container *size* changes (e.g. details panel open/close),
/// not during zoom/scroll gestures which also trigger layoutSubviews.
final class ZoomScrollView: UIScrollView {
    var onLayoutSubviews: (() -> Void)?
    private var lastBoundsSize: CGSize = .zero

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let iv = subviews.first as? UIImageView,
              bounds.size.width > 0, bounds.size.height > 0 else { return }
        guard bounds.size != lastBoundsSize else { return }
        lastBoundsSize = bounds.size
        iv.frame = CGRect(origin: .zero, size: bounds.size)
        contentSize = bounds.size
        setZoomScale(minimumZoomScale, animated: false)
        onLayoutSubviews?()
    }
}
