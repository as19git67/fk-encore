import Foundation

/// Decision logic and persisted settings for the fullscreen slideshow.
///
/// Mirrors the web's `frontend/src/utils/slideshow.ts` and
/// `slideshowInterval.ts` so both clients behave the same way; the rules are
/// documented once in `docs/photo-slideshow.md`. The view owns the timer and
/// the `isPlaying` flag — everything here is pure, so the awkward parts (the
/// no-wrap stop, when the caption may appear, a stale stored interval) are
/// testable without a view.
enum Slideshow {

    // MARK: - Interval

    /// Selectable gaps between photos, in seconds. Same set the web offers.
    static let intervalOptions: [TimeInterval] = [3, 5, 10, 15, 20, 30]

    /// Used until the user picks one.
    static let defaultInterval: TimeInterval = 5

    /// `UserDefaults` key backing the per-device interval. The web stores the
    /// same setting per browser in `localStorage`; there is no server-side
    /// sync, so the two are independent by design.
    static let intervalDefaultsKey = "slideshow_interval_seconds"

    /// Coerce a stored interval back onto the offered set. A value from an
    /// older build — or a hand-edited default — would otherwise drive the timer
    /// with something never offered in the menu.
    static func normalizedInterval(
        _ value: TimeInterval,
        fallback: TimeInterval = defaultInterval
    ) -> TimeInterval {
        intervalOptions.contains(value) ? value : fallback
    }

    /// Compact menu label, e.g. "5s".
    static func label(for interval: TimeInterval) -> String {
        "\(Int(interval.rounded()))s"
    }

    // MARK: - Playback

    /// The slideshow stops at the last photo — it never wraps around. Callers
    /// use this to flip the button back to "play" so the icon keeps matching
    /// what a tap would do.
    static func reachedEnd(playing: Bool, hasNext: Bool) -> Bool {
        playing && !hasNext
    }

    /// Whether the advance timer should be armed right now: the user started
    /// playback, an interval is configured, there is somewhere to go, and the
    /// photo on screen has finished loading.
    ///
    /// `currentLoaded` matches the web's `shouldArmSlideshow`: the gap is meant
    /// to be time spent *looking at* a photo, so it starts once the photo is up
    /// rather than while it is still a spinner. A photo whose load failed counts
    /// as loaded — otherwise one broken image stalls playback for good.
    ///
    /// Opening the details view deliberately does *not* pause — same as the
    /// web, where the description is in the sidebar anyway.
    static func shouldAdvance(
        playing: Bool,
        interval: TimeInterval,
        hasNext: Bool,
        currentLoaded: Bool
    ) -> Bool {
        playing && interval > 0 && hasNext && currentLoaded
    }

    /// Whether the description caption belongs on screen: only while playing,
    /// only when the details view is closed (it shows the description already),
    /// and only when there is a non-blank description to show.
    static func shouldShowCaption(
        playing: Bool,
        showDetails: Bool,
        description: String?
    ) -> Bool {
        guard playing, !showDetails else { return false }
        let trimmed = (description ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty
    }
}
