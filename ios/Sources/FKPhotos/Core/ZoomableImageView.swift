import SwiftUI
import UIKit

/// UIScrollView-based photo viewer with pinch-to-zoom and double-tap zoom.
/// At zoom 1x the UIScrollView has no scrollable content, so horizontal swipes
/// pass through to the parent TabView page switcher automatically.
struct ZoomableImageView: UIViewRepresentable {
    let image: UIImage

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> ZoomScrollView {
        let sv = ZoomScrollView()
        sv.delegate = context.coordinator
        sv.minimumZoomScale = 1
        sv.maximumZoomScale = 5
        sv.showsHorizontalScrollIndicator = false
        sv.showsVerticalScrollIndicator = false
        sv.backgroundColor = .black
        sv.contentInsetAdjustmentBehavior = .never
        sv.bouncesZoom = true

        let iv = UIImageView(image: image)
        iv.contentMode = .scaleAspectFit
        iv.backgroundColor = .black
        sv.addSubview(iv)
        context.coordinator.imageView = iv

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
    }
}
