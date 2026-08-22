import CoreGraphics
import Foundation

/// How a photo is shaped. Near-square photos are their own case: pairing two
/// of them would waste as much screen as showing them one at a time, so they
/// are deliberately not eligible.
enum SlideOrientation: Equatable, Sendable {
    case portrait
    case landscape
    case square

    /// Photos within ±5% of square count as `.square`. The tolerance keeps a
    /// 4:3-ish crop that is only *just* wider than tall out of the pairing
    /// rules, where it would render as two nearly-full-width letterboxes.
    init(size: CGSize) {
        guard size.width > 0, size.height > 0 else {
            self = .square
            return
        }
        let ratio = size.width / size.height
        if ratio > 1.05 {
            self = .landscape
        } else if ratio < 0.95 {
            self = .portrait
        } else {
            self = .square
        }
    }
}

/// Orientation of the screen the slideshow runs on. A square screen (or an
/// unknown size) counts as portrait — the common phone case.
enum ScreenOrientation: Equatable, Sendable {
    case portrait
    case landscape

    init(size: CGSize) {
        self = size.width > size.height ? .landscape : .portrait
    }
}

/// One step of the slideshow: either a single photo filling the screen, or two
/// photos sharing it.
struct SlideshowSlide: Equatable, Sendable {
    let photoIndices: [Int]

    var isPair: Bool { photoIndices.count == 2 }
    var first: Int { photoIndices[0] }
}

/// Groups a photo sequence into slides.
///
/// A photo held the "wrong way round" for the screen — a landscape photo on a
/// portrait phone — only fills a band across the middle, leaving most of the
/// screen black. Two of them stacked fill it properly, so the slideshow pairs
/// them (and pairs portrait photos side by side when the phone is turned).
/// Everything else stays a single, full-screen slide.
///
/// Orientation comes from the decoded image, so it is unknown until a photo has
/// loaded. Planning therefore runs incrementally: it commits as many slides as
/// it can decide and stops at the first photo it cannot, rather than guessing
/// and re-planning later — slides already on screen must never renumber.
enum SlideshowPlanner {

    /// Whether a photo of this shape is a pairing candidate on this screen.
    static func canPair(screen: ScreenOrientation, photo: SlideOrientation) -> Bool {
        switch screen {
        case .portrait:  return photo == .landscape
        case .landscape: return photo == .portrait
        }
    }

    /// Appends slides for the photos not covered by `plan` yet.
    ///
    /// `orientations[i] == nil` means "not loaded yet". Planning normally stops
    /// there; with `force` it commits *that one* photo as a single slide and
    /// then goes back to waiting, which is what keeps playback moving when a
    /// download is slow without flattening the whole rest of the show into
    /// singles. Existing entries are never touched.
    static func extend(
        plan: [SlideshowSlide],
        orientations: [SlideOrientation?],
        screen: ScreenOrientation,
        force: Bool = false
    ) -> [SlideshowSlide] {
        var result = plan
        var i = plan.reduce(0) { $0 + $1.photoIndices.count }
        // Spent on the first photo it unblocks; everything after it is planned
        // by the normal rules again.
        var forceRemaining = force

        while i < orientations.count {
            guard let current = orientations[i] else {
                guard forceRemaining else { break }
                forceRemaining = false
                result.append(SlideshowSlide(photoIndices: [i]))
                i += 1
                continue
            }

            if canPair(screen: screen, photo: current), i + 1 < orientations.count {
                guard let next = orientations[i + 1] else {
                    // The partner may still turn out to be pairable, so only a
                    // forced pass gives up on it and shows this photo alone.
                    guard forceRemaining else { break }
                    forceRemaining = false
                    result.append(SlideshowSlide(photoIndices: [i]))
                    i += 1
                    continue
                }
                if canPair(screen: screen, photo: next) {
                    result.append(SlideshowSlide(photoIndices: [i, i + 1]))
                    i += 2
                    continue
                }
            }

            result.append(SlideshowSlide(photoIndices: [i]))
            i += 1
        }

        return result
    }

    /// How many photos `plan` covers. Equal to the photo count once planning
    /// has caught up with the whole sequence.
    static func plannedPhotoCount(_ plan: [SlideshowSlide]) -> Int {
        plan.reduce(0) { $0 + $1.photoIndices.count }
    }
}

/// Playback position of a story-style slideshow, in slides.
///
/// Free of SwiftUI so auto-advance, tap-to-seek and the end-of-show rule are
/// unit-testable. The plan can still be growing while this runs, so every
/// method takes the current slide count and whether planning has finished:
/// running out of *planned* slides holds the show, running out of *photos*
/// ends it.
struct SlideshowPlayback: Equatable, Sendable {
    private(set) var slideIndex: Int = 0
    /// Fill ratio (0...1) of the current slide.
    private(set) var progress: Double = 0
    /// True once playback has advanced past the final slide.
    private(set) var finished: Bool = false

    init() {}

    /// Advances by `delta` seconds, with `perSlide` seconds allotted per slide.
    /// Carries leftover progress across slide boundaries. At the end of the
    /// planned slides it parks at full progress; whether that is the end of the
    /// show depends on `planComplete`.
    mutating func tick(
        delta: Double,
        perSlide: Double,
        slideCount: Int,
        planComplete: Bool
    ) {
        guard !finished, slideCount > 0, perSlide > 0, delta > 0 else { return }
        progress += delta / perSlide
        while progress >= 1 {
            if slideIndex >= slideCount - 1 {
                progress = 1
                if planComplete { finished = true }
                return
            }
            slideIndex += 1
            progress -= 1
        }
    }

    /// Jump to the next slide (tap on the right). Finishes when already on the
    /// last slide of a complete plan; on an incomplete one it waits instead, so
    /// an impatient tap never cuts the show short.
    mutating func next(slideCount: Int, planComplete: Bool) {
        guard slideCount > 0 else { return }
        if slideIndex >= slideCount - 1 {
            progress = 1
            if planComplete { finished = true }
        } else {
            slideIndex += 1
            progress = 0
            finished = false
        }
    }

    /// Jump to the previous slide (tap on the left); clamps at the first.
    mutating func previous() {
        finished = false
        slideIndex = max(0, slideIndex - 1)
        progress = 0
    }

    /// The slide showing now, or nil while the plan is still empty.
    func currentSlide(in plan: [SlideshowSlide]) -> SlideshowSlide? {
        plan.indices.contains(slideIndex) ? plan[slideIndex] : nil
    }

    /// Fill fraction for the progress segment of photo `photoIndex`.
    ///
    /// The bar has one segment per *photo*, not per slide, so it keeps its
    /// shape while the plan is still growing. Both segments of a pair fill
    /// together, which is also what makes a pair read as one step.
    func fillFraction(forPhotoAt photoIndex: Int, plan: [SlideshowSlide]) -> Double {
        for (i, slide) in plan.enumerated() where slide.photoIndices.contains(photoIndex) {
            if i < slideIndex { return 1 }
            if i > slideIndex { return 0 }
            return progress
        }
        // Not planned yet — always ahead of the current slide.
        return 0
    }
}
