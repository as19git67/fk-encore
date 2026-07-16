import Foundation

/// Kind of recap as classified by the server (`photo/recaps.service.ts`).
/// Decoded leniently via `RecapSummary.recapKind` so an unknown future kind
/// never fails the whole list decode.
enum RecapKind: String, Sendable {
    case onThisDay = "on_this_day"
    case trip
    case person
    case other

    init(raw: String) {
        self = RecapKind(rawValue: raw) ?? .other
    }

    var systemImage: String {
        switch self {
        case .onThisDay: return "calendar"
        case .trip:      return "map"
        case .person:    return "person.2"
        case .other:     return "sparkles"
        }
    }
}

/// One recap as returned by `GET /recaps`. Field names mirror the JSON exactly.
struct RecapSummary: Codable, Identifiable, Sendable {
    let id: Int
    let kind: String
    let title: String
    let subtitle: String?
    let cover_photo_id: Int?
    let period_start: String?
    let period_end: String?
    let photo_count: Int
    let created_at: String
    let dismissed_at: String?
    let seen_at: String?

    var recapKind: RecapKind { RecapKind(raw: kind) }
}

/// Builder metadata stored per recap. The JSON object carries kind-specific
/// keys; only the ones the app renders are decoded, everything else is
/// ignored. Trip recaps persist home + destination coordinates for the
/// animated map intro.
struct RecapSeed: Codable, Sendable {
    let home_lat: Double?
    let home_lon: Double?
    let centroid_lat: Double?
    let centroid_lon: Double?
    let location_city: String?
}

/// A single recap with its ordered photo IDs (`GET /recaps/:id`). Photo metadata
/// is resolved separately via the shared `/photos/details` batch endpoint.
struct RecapDetails: Codable, Identifiable, Sendable {
    let id: Int
    let kind: String
    let title: String
    let subtitle: String?
    let cover_photo_id: Int?
    let period_start: String?
    let period_end: String?
    let photo_count: Int
    let created_at: String
    let dismissed_at: String?
    let seen_at: String?
    let photo_ids: [Int]
    let seed: RecapSeed?

    var recapKind: RecapKind { RecapKind(raw: kind) }
}

/// Self-hosted background track for the recap player (`GET /recaps/:id`,
/// field `music`). `url` is an API path without host; stream it through the
/// shared `APIClient`.
struct RecapMusicTrack: Codable, Sendable {
    let id: String
    let mood: String
    let title: String
    let url: String
}

struct ListRecapsResponse: Codable, Sendable { let recaps: [RecapSummary] }
struct GetRecapResponse: Codable, Sendable {
    let recap: RecapDetails
    let music: RecapMusicTrack?
}

/// Minimal photo metadata needed to render a recap slide / cover, decoded from
/// the shared `/photos/details` batch endpoint (extra fields are ignored).
struct RecapPhoto: Codable, Identifiable, Sendable {
    let id: Int
    let filename: String
    let taken_at: String?
    let location_name: String?
    let location_city: String?
    let description: String?
}

struct RecapPhotoDetailsResponse: Codable, Sendable { let photos: [RecapPhoto] }

/// Pure playback state machine for the story-style recap player. Deliberately
/// free of SwiftUI so the auto-advance / tap-to-seek logic is unit-testable.
struct RecapPlayback: Equatable {
    let count: Int
    private(set) var index: Int
    /// Fill ratio (0...1) of the current slide's progress bar.
    private(set) var progress: Double
    /// True once playback has advanced past the final slide.
    private(set) var finished: Bool

    init(count: Int) {
        self.count = count
        self.index = 0
        self.progress = 0
        self.finished = count == 0
    }

    /// Advances playback by `delta` seconds, with `perItem` seconds allotted per
    /// slide. Carries leftover progress across slide boundaries and flags
    /// `finished` when the last slide completes.
    mutating func tick(delta: Double, perItem: Double) {
        guard count > 0, !finished, perItem > 0, delta > 0 else { return }
        progress += delta / perItem
        while progress >= 1 {
            if index >= count - 1 {
                progress = 1
                finished = true
                return
            }
            index += 1
            progress -= 1
        }
    }

    /// Jump to the next slide (tap right edge). Finishes when already on the last.
    mutating func next() {
        guard count > 0 else { return }
        if index >= count - 1 {
            progress = 1
            finished = true
        } else {
            index += 1
            progress = 0
            finished = false
        }
    }

    /// Jump to the previous slide (tap left edge); clamps at the first slide.
    mutating func previous() {
        guard count > 0 else { return }
        finished = false
        index = max(0, index - 1)
        progress = 0
    }

    /// Fill fraction for the progress bar of slide `i`.
    func fillFraction(for i: Int) -> Double {
        if i < index { return 1 }
        if i > index { return 0 }
        return progress
    }
}
