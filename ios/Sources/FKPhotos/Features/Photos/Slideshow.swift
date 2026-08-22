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

    // MARK: - Caption

    /// The description to show under a slide, or nil when there is nothing
    /// worth a caption. Blank-but-present descriptions exist in the data, and
    /// they must not render an empty bubble over the photo.
    static func caption(_ description: String?) -> String? {
        let trimmed = (description ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
