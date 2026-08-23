import Foundation

/// Settings shared by every slideshow in the app.
///
/// The playback machinery itself lives in `SlideshowPlan.swift` (planning and
/// position) and `SlideshowStage.swift` (what one slide looks like); this is
/// only the per-device pace and the caption rule. Documented once in
/// `docs/photo-slideshow.md`.
enum Slideshow {

    // MARK: - Interval

    /// Selectable gaps between slides, in seconds. Same set the web offers.
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

    /// The same label, marking the interval in use. The chooser is a plain
    /// list of actions and carries no selection state of its own, so the
    /// current value has to be visible in the text.
    static func label(for interval: TimeInterval, current: TimeInterval) -> String {
        let base = label(for: interval)
        return interval == normalizedInterval(current) ? "\(base) ✓" : base
    }

    // MARK: - Music

    /// `UserDefaults` key backing the per-device mute state. A recap decides
    /// its own sound each time it plays; a photo slideshow is started far more
    /// casually, so silencing it once silences it for good.
    static let musicMutedDefaultsKey = "slideshow_music_muted"

    /// `UserDefaults` key backing the last track the user picked. An album has
    /// no server-suggested track the way a recap does, so the previous choice
    /// stands in for one.
    static let musicTrackDefaultsKey = "slideshow_music_track"

    /// The stored mute state, read directly because `@AppStorage` is not
    /// available yet while a view's `init` is building its state.
    static func storedMusicMuted(
        _ defaults: UserDefaults = .standard
    ) -> Bool {
        defaults.bool(forKey: musicMutedDefaultsKey)
    }

    /// The stored track id, or nil when there is none to prefer. An empty
    /// string is what `@AppStorage` yields for an unset key, and it must not
    /// be offered as an id to match against.
    static func storedMusicTrackId(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    // MARK: - Caption

    /// The description to show under a slide, or nil when there is nothing
    /// worth a caption. Blank-but-present descriptions exist in the data, and
    /// they must not render an empty bubble over the photo.
    static func caption(_ description: String?) -> String? {
        let trimmed = (description ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
