import SwiftUI
import UIKit

/// One photo as the slideshow needs to draw it.
struct SlideshowFrame: Identifiable, Equatable {
    /// Photo id — also the Ken-Burns seed, so a photo always drifts the same
    /// way no matter which show it appears in.
    let id: Int
    let image: UIImage?
    /// Download failed; drawn as an error glyph instead of a spinner.
    let failed: Bool
    /// Server-computed focal point (face centre, normalized 0..1), used to
    /// place the crop and to aim the Ken-Burns motion.
    let focal: CGPoint?

    static func == (lhs: SlideshowFrame, rhs: SlideshowFrame) -> Bool {
        lhs.id == rhs.id && lhs.image === rhs.image && lhs.failed == rhs.failed
    }
}

/// Draws one slide: a single photo filling the screen, or two sharing it.
///
/// A pair is stacked across the screen's short axis — two landscape photos
/// above each other on a portrait phone, two portrait photos beside each other
/// on a turned one — and the halves slide in from opposite edges, so the pair
/// reads as one deliberate step rather than a photo that failed to fill.
struct SlideshowStageView: View {
    let frames: [SlideshowFrame]
    let screen: ScreenOrientation
    /// Ken-Burns duration; slightly longer than the slide's own screen time so
    /// the motion never visibly stops before the crossfade.
    let duration: Double

    var body: some View {
        if frames.count == 2 {
            pair
        } else if let frame = frames.first {
            tile(frame, edge: nil)
        } else {
            Color.black
        }
    }

    @ViewBuilder
    private var pair: some View {
        let layout = screen == .portrait
            ? AnyLayout(VStackLayout(spacing: 4))
            : AnyLayout(HStackLayout(spacing: 4))
        let edges: (Edge, Edge) = screen == .portrait
            ? (.top, .bottom)
            : (.leading, .trailing)
        layout {
            tile(frames[0], edge: edges.0)
            tile(frames[1], edge: edges.1)
        }
    }

    @ViewBuilder
    private func tile(_ frame: SlideshowFrame, edge: Edge?) -> some View {
        ZStack {
            Color.black
            if let image = frame.image {
                KenBurnsSlide(
                    image: image,
                    seed: frame.id,
                    duration: duration,
                    focal: frame.focal
                )
            } else if frame.failed {
                Image(systemName: "exclamationmark.triangle")
                    .font(.largeTitle)
                    .foregroundStyle(.white.opacity(0.6))
            } else {
                ProgressView().tint(.white)
            }
        }
        .clipped()
        // A pair announces itself by sliding in; a single photo crossfades, as
        // it always has. Both leave by fading, so the outgoing slide never
        // drags the eye off the edge of the screen.
        .transition(
            .asymmetric(
                insertion: edge.map { AnyTransition.move(edge: $0) } ?? .opacity,
                removal: .opacity
            )
            .animation(.easeInOut(duration: 0.5))
        )
    }
}

/// Pan/zoom parameters for one Ken-Burns run. Derived deterministically from
/// the photo id (same hash as the web player), so a photo always moves the
/// same way. Pure, so the focal-point rule below is testable.
struct KenBurnsMotion: Equatable {
    let fromScale: CGFloat
    let toScale: CGFloat
    let fromX: CGFloat
    let fromY: CGFloat
    let toX: CGFloat
    let toY: CGFloat

    /// Offsets are fractions of the slide size; the minimum scale of 1.06
    /// leaves enough overscan that a ±1.5% pan never exposes an edge.
    static let amplitude: CGFloat = 0.015

    /// - Parameter focused: whether the photo has a focal point (a detected
    ///   face). The pan is otherwise aimless: it drifts between two random
    ///   offsets and can just as easily end up on a hedge as on the person.
    ///   With a focal point the *zoomed-in* end of the run is pinned to the
    ///   focal crop — offset zero — so the motion always resolves onto the
    ///   face and only the wide end wanders.
    static func make(seed: Int, focused: Bool) -> KenBurnsMotion {
        func r(_ x: Double) -> Double {
            let s = sin(Double(seed) * 9301 + x * 49297) * 233280
            return s - s.rounded(.down)
        }
        func offset(_ x: Double) -> CGFloat {
            CGFloat((r(x) - 0.5) * 2 * Double(amplitude))
        }
        let zoomIn = r(1) > 0.5
        let wideX = offset(2)
        let wideY = offset(3)
        let driftX = offset(4)
        let driftY = offset(5)

        // The tight end is the focal crop itself when there is one; without a
        // focal point both ends are simply random, as before.
        let tightX: CGFloat = focused ? 0 : driftX
        let tightY: CGFloat = focused ? 0 : driftY

        return KenBurnsMotion(
            fromScale: zoomIn ? 1.06 : 1.18,
            toScale: zoomIn ? 1.18 : 1.06,
            fromX: zoomIn ? wideX : tightX,
            fromY: zoomIn ? wideY : tightY,
            toX: zoomIn ? tightX : wideX,
            toY: zoomIn ? tightY : wideY
        )
    }
}

/// Renders one photo with a slow Ken-Burns pan/zoom. When a focal point
/// (`auto_crop`) is present, the fill crop is shifted so faces stay in view
/// instead of the geometric centre, and the motion is aimed at it.
struct KenBurnsSlide: View {
    let image: UIImage
    let seed: Int
    let duration: Double
    var focal: CGPoint? = nil

    @State private var animate = false

    var body: some View {
        let m = KenBurnsMotion.make(seed: seed, focused: focal != nil)
        GeometryReader { geo in
            let base = Self.focalOffset(
                focal: focal,
                imageSize: image.size,
                containerSize: geo.size
            )
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: geo.size.width, height: geo.size.height)
                .scaleEffect(animate ? m.toScale : m.fromScale)
                .offset(
                    x: base.width + (animate ? m.toX : m.fromX) * geo.size.width,
                    y: base.height + (animate ? m.toY : m.fromY) * geo.size.height
                )
                .onAppear {
                    withAnimation(.linear(duration: duration)) { animate = true }
                }
        }
        .clipped()
    }

    /// `scaledToFill` centres the image; this shifts the crop so the focal
    /// point moves towards the visible area. The offset is bounded by half
    /// the fill overflow per axis (focal 0/1 aligns the image edge with the
    /// container edge), matching CSS `object-position` semantics.
    static func focalOffset(
        focal: CGPoint?,
        imageSize: CGSize,
        containerSize: CGSize
    ) -> CGSize {
        guard let focal else { return .zero }
        guard imageSize.width > 0, imageSize.height > 0,
              containerSize.width > 0, containerSize.height > 0 else {
            return .zero
        }
        let scale = max(
            containerSize.width / imageSize.width,
            containerSize.height / imageSize.height
        )
        let overflowX = max(0, imageSize.width * scale - containerSize.width)
        let overflowY = max(0, imageSize.height * scale - containerSize.height)
        let fx = min(max(focal.x, 0), 1)
        let fy = min(max(focal.y, 0), 1)
        return CGSize(
            width: (0.5 - fx) * overflowX,
            height: (0.5 - fy) * overflowY
        )
    }
}

/// The story progress strip along the top of a player.
///
/// One segment per photo, as long as the segments stay legible. A slideshow
/// over a whole album can run to several hundred photos, and there the strip
/// breaks twice over: the segments become invisible hairlines, and the spacing
/// between them alone outgrows the screen. An `HStack` that cannot fit widens
/// its parent instead of shrinking, so the over-wide strip took the player's
/// `ZStack` with it and shoved the photo sideways off the screen — a 247-photo
/// album needed 984 pt of spacing on a 402 pt screen and left a 99 pt slice of
/// the photo hanging off the right edge. Past the point where segments fit,
/// the strip therefore collapses to a single bar showing overall progress.
struct SlideshowProgressTrack: View {
    let photoCount: Int
    /// Fill of one photo's segment, 0...1.
    let fill: (Int) -> Double
    /// Progress across the whole show, drawn when the strip has collapsed.
    let overall: Double

    /// Gap between segments, and the narrowest a segment may become before
    /// segmenting is given up on entirely.
    static let spacing: CGFloat = 4
    static let minimumSegment: CGFloat = 6
    static let height: CGFloat = 3

    /// Whether `count` segments still fit across `width`.
    ///
    /// Also the guarantee that the strip never overflows: a segment can shrink
    /// to nothing, so the `HStack`'s real minimum is the spacing alone, which
    /// this bound comfortably covers.
    static func showsSegments(count: Int, width: CGFloat) -> Bool {
        guard count > 0, width > 0 else { return false }
        let needed = CGFloat(count) * minimumSegment
            + CGFloat(count - 1) * spacing
        return needed <= width
    }

    var body: some View {
        GeometryReader { geo in
            if Self.showsSegments(count: photoCount, width: geo.size.width) {
                HStack(spacing: Self.spacing) {
                    ForEach(0..<photoCount, id: \.self) { i in
                        SlideshowProgressBar(fraction: fill(i))
                    }
                }
            } else {
                SlideshowProgressBar(fraction: overall)
            }
        }
        .frame(height: Self.height)
    }
}

/// One segment of the story progress strip.
struct SlideshowProgressBar: View {
    let fraction: Double

    var body: some View {
        GeometryReader { geo in
            Capsule()
                .fill(.white.opacity(0.3))
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(.white)
                        .frame(width: geo.size.width * min(max(fraction, 0), 1))
                }
        }
    }
}
