import SwiftUI
import UIKit

/// UIScrollView-based photo viewer with pinch-to-zoom and double-tap zoom.
/// At zoom 1x the UIScrollView has no scrollable content, so horizontal swipes
/// pass through to the parent TabView page switcher automatically.
struct ZoomableImageView: UIViewRepresentable {
    let image: UIImage
    let faceBBox: FaceBBox?

    init(image: UIImage, faceBBox: FaceBBox? = nil) {
        self.image = image
        self.faceBBox = faceBBox
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

        sv.onLayoutSubviews = { [weak c = context.coordinator] in
            c?.updateBBoxPosition()
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
        guard let iv = context.coordinator.imageView, iv.image !== image else { return }
        iv.image = image
        sv.setZoomScale(1, animated: false)
        sv.setNeedsLayout()
    }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        weak var imageView: UIImageView?
        weak var bboxView: UIView?
        var faceBBox: FaceBBox?

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

        /// Position the bbox view within the image view's local coordinate space,
        /// accounting for aspect-fit letterboxing. Called when bounds change; zoom/pan
        /// is handled automatically because the bbox is a subview of the image view.
        func updateBBoxPosition() {
            guard let iv = imageView,
                  let bbox = faceBBox,
                  let bv = bboxView,
                  let imgSize = iv.image?.size,
                  imgSize.width > 0, imgSize.height > 0,
                  iv.bounds.width > 0, iv.bounds.height > 0 else { return }
            let ar = imgSize.width / imgSize.height
            let viewAR = iv.bounds.width / iv.bounds.height
            let rW: CGFloat = ar > viewAR ? iv.bounds.width : iv.bounds.height * ar
            let rH: CGFloat = ar > viewAR ? iv.bounds.width / ar : iv.bounds.height
            let ox = (iv.bounds.width - rW) / 2
            let oy = (iv.bounds.height - rH) / 2
            bv.frame = CGRect(
                x: ox + CGFloat(bbox.x) * rW,
                y: oy + CGFloat(bbox.y) * rH,
                width: max(CGFloat(bbox.width) * rW, 4),
                height: max(CGFloat(bbox.height) * rH, 4)
            )
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
