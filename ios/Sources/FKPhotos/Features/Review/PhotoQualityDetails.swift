import Foundation

/// The AI's score, broken into the criteria it was made of (#1021, stage B).
///
/// A port of the web's `frontend/src/utils/compareQualityDetails.ts` and
/// `comparePhotoScore.ts`. When two photos of the same moment score 71 % and
/// 68 %, the number alone says nothing about *why*; the breakdown says one is
/// sharper and the other better composed, which is the thing that decides
/// which to keep.
///
/// Pure: two dictionaries in, rows out.
enum PhotoQualityDetails {

    /// One criterion, with both photos' values side by side. A nil value means
    /// that photo has no reading for this criterion — the other one measured
    /// something it did not, which is different from scoring zero.
    struct Row: Identifiable, Equatable, Sendable {
        let key: String
        let first: Double?
        let second: Double?

        var id: String { key }

        /// What to call this criterion on screen.
        var label: String { PhotoQualityDetails.label(for: key) }

        /// Which side is ahead, if either. Nil when they tie or when one of
        /// them has nothing to compare.
        var leader: Side? {
            guard let first, let second else { return nil }
            if first > second { return .first }
            if second > first { return .second }
            return nil
        }
    }

    enum Side: Equatable, Sendable {
        case first, second
    }

    /// Every criterion either photo carries, in a stable order.
    ///
    /// Sorted by the **raw key**, not the translated label: the two clients
    /// then list the rows in the same order, and the order does not shift when
    /// a label is reworded. Values are clamped to 0…1 — a score outside that
    /// would draw a bar past the end of its track.
    static func rows(
        first: [String: Double]?,
        second: [String: Double]?
    ) -> [Row] {
        let empty: [String: Double] = [:]
        let keys = Set((first ?? empty).keys).union((second ?? empty).keys)
        return keys.sorted().map { key in
            Row(
                key: key,
                first: normalized(first?[key]),
                second: normalized(second?[key])
            )
        }
    }

    /// A score as a fraction of 1, or nil when there is nothing usable.
    static func normalized(_ value: Double?) -> Double? {
        guard let value, value.isFinite else { return nil }
        return min(1, max(0, value))
    }

    /// A percentage, or „–" when the photo has no reading.
    static func percent(_ value: Double?) -> String {
        guard let value else { return "–" }
        return "\(Int((value * 100).rounded())) %"
    }

    // MARK: - Labels

    /// The German names the web uses, so the same row reads the same on both.
    private static let labels: [String: String] = [
        "sharpness": "Schärfe",
        "contrast": "Kontrast",
        "exposure": "Belichtung",
        "clip_aesthetics": "Ästhetik",
        "clip_composition": "Komposition",
        "clip_technical": "Technik",
        "face_sharpness": "Gesichtsschärfe",
        "eyes_open": "Augen offen",
        "face_composition": "Gesichtsposition",
    ]

    /// The name for a criterion.
    ///
    /// An unknown key keeps its raw name rather than being dropped: the
    /// scoring service can add a criterion before either client knows about
    /// it, and „bokeh 82 %" is more use than a row that silently disappeared.
    static func label(for key: String) -> String {
        labels[key] ?? key
    }

    // MARK: - Freshening a photo

    /// What a fresh read of a photo says about its quality.
    struct Fresh: Sendable {
        let score: Double?
        let details: [String: Double]?

        init(score: Double?, details: [String: Double]?) {
            self.score = score
            self.details = details
        }

        init(_ photo: PhotoWithCuration) {
            self.init(score: photo.ai_quality_score, details: photo.ai_quality_details)
        }
    }

    /// Overlay a fresh reading onto what the review queue already handed over.
    ///
    /// The queue's copy of a photo can predate the quality scan, which is why
    /// the web re-fetches here too. Only the quality fields are taken: a fresh
    /// read must not overwrite the curation status, or an in-session hide
    /// would be undone by opening a table.
    ///
    /// A fresh value of nil falls back to what was already known, so a photo
    /// fetched before its scan finishes never loses a score it had.
    static func merged(
        score: Double?,
        details: [String: Double]?,
        fresh: Fresh?
    ) -> (score: Double?, details: [String: Double]?) {
        guard let fresh else { return (score, details) }
        return (fresh.score ?? score, fresh.details ?? details)
    }
}
