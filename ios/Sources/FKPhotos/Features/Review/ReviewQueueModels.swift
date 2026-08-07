import CoreGraphics
import Foundation

// MARK: - Wire types (GET /photos/groups/review-queue)

/// How sure the server's auto-pick is about its suggestion. Decoded leniently
/// through `ReviewQueueGroup.confidence` so a future stratum never fails the
/// whole queue.
enum ReviewConfidence: String, CaseIterable, Identifiable, Sendable {
    case high
    case medium
    case low

    var id: String { rawValue }

    var label: String {
        switch self {
        case .high:   return "Sicher"
        case .medium: return "Mittel"
        case .low:    return "Unsicher"
        }
    }

    var systemImage: String {
        switch self {
        case .high:   return "checkmark.seal.fill"
        case .medium: return "questionmark.circle"
        case .low:    return "exclamationmark.triangle"
        }
    }
}

/// Anonymized decisions of *other* users who share an album containing this
/// photo. Only explicit votes are counted — "visible" is the implicit default
/// and produces no row, so both counters at 0 means "no peer signal".
struct ReviewPeerCuration: Codable, Sendable, Equatable {
    let hidden: Int
    let favorite: Int

    var hasSignal: Bool { hidden > 0 || favorite > 0 }
}

struct ReviewQueuePhoto: Codable, Identifiable, Sendable, Equatable {
    let id: Int
    let filename: String
    let taken_at: String?
    let curation: CurationStatus
    let ai_picked: Bool
    /// 0…1, or nil while the quality scan hasn't reached this photo.
    let ai_quality_score: Double?
    let peer_curation: ReviewPeerCuration?

    var qualityPercent: Int? {
        ai_quality_score.map { Int(($0 * 100).rounded()) }
    }
}

/// One similar-photo group awaiting review.
///
/// The `duplicate_*` and `runner_up_delta` fields are optional purely for
/// decode resilience against an older server; read them through the computed
/// accessors below.
struct ReviewQueueGroup: Codable, Identifiable, Sendable, Equatable {
    let id: Int
    let cover_photo_id: Int?
    let member_count: Int
    let ai_picked_photo_ids: [Int]?
    let ai_picked_confidence: String?
    let runner_up_delta: Double?
    let duplicate_candidate: Bool?
    let duplicate_recommended_photo_id: Int?
    let duplicate_deletable_count: Int?
    let photos: [ReviewQueuePhoto]

    var pickedPhotoIds: [Int] { ai_picked_photo_ids ?? [] }

    var confidence: ReviewConfidence? {
        ai_picked_confidence.flatMap(ReviewConfidence.init(rawValue:))
    }

    /// Whether the server has a suggestion at all. Groups without one can only
    /// be kept wholesale or resolved by picking a photo by hand.
    var hasAiPick: Bool { !pickedPhotoIds.isEmpty }

    var isDuplicateCandidate: Bool { duplicate_candidate ?? false }

    /// True once at least one peer voted on any member — gates the
    /// "Konsens übernehmen" action, which is a no-op without a signal.
    var hasPeerSignal: Bool {
        photos.contains { $0.peer_curation?.hasSignal ?? false }
    }

    /// Photos in display order: the AI's pick first so the card leads with the
    /// suggestion the swipe would accept.
    var orderedPhotos: [ReviewQueuePhoto] {
        let picked = Set(pickedPhotoIds)
        return photos.sorted { lhs, rhs in
            let l = picked.contains(lhs.id)
            let r = picked.contains(rhs.id)
            if l != r { return l }
            return lhs.id < rhs.id
        }
    }
}

struct ReviewQueueResponse: Codable, Sendable {
    let total: Int
    let high_confidence_total: Int?
    let offset: Int
    let groups: [ReviewQueueGroup]
}

// MARK: - Decisions

/// One review decision. Carries the whole group so an undo can put the card
/// back exactly as it was without another round trip.
struct ReviewDecision: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        /// Keep the AI's pick, hide every other member.
        case acceptAiPick
        /// Mark the group reviewed without hiding anything.
        case keepAll
        /// Keep exactly these photos, hide the rest.
        case pick([Int])
        /// Favorite the AI's pick, then accept it.
        case favoriteAndAccept
        /// Adopt the majority of the album peers' decisions.
        case peerConsensus

        var label: String {
            switch self {
            case .acceptAiPick:      return "Vorschlag übernommen"
            case .keepAll:           return "Alle behalten"
            case .pick:              return "Foto ausgewählt"
            case .favoriteAndAccept: return "Favorisiert & übernommen"
            case .peerConsensus:     return "Konsens übernommen"
            }
        }
    }

    let group: ReviewQueueGroup
    let kind: Kind

    /// The photos this decision keeps — everything else in the group gets
    /// hidden. Empty for `keepAll` / `peerConsensus`, where the server decides.
    var keptPhotoIds: [Int] {
        switch kind {
        case .acceptAiPick, .favoriteAndAccept: return group.pickedPhotoIds
        case .pick(let ids):                    return ids
        case .keepAll, .peerConsensus:          return []
        }
    }
}

// MARK: - Queue state machine

/// The cursor over the loaded groups plus a **one-deep** decision buffer.
///
/// There is no server-side "un-review" endpoint, so undo cannot work by
/// calling the API and taking it back. Instead the newest decision is held
/// locally and only pushed to the server when the *next* decision is made (or
/// when the screen is left). That gives the guaranteed single-step undo the
/// review flow needs, and the worst case if the app dies mid-session is one
/// decision that was never sent — the group simply stays unreviewed and comes
/// back next time, which is the safe direction to fail in.
///
/// Kept free of SwiftUI and networking so `ReviewQueueTests` can drive it.
struct ReviewQueueState: Equatable, Sendable {
    private(set) var groups: [ReviewQueueGroup] = []
    private(set) var index: Int = 0
    private(set) var decidedCount: Int = 0
    /// The decision not yet sent to the server — the one `undo()` takes back.
    private(set) var pending: ReviewDecision?
    /// Unreviewed groups the server reports, used for the progress bar.
    private(set) var total: Int = 0

    var current: ReviewQueueGroup? {
        groups.indices.contains(index) ? groups[index] : nil
    }

    var canUndo: Bool { pending != nil }

    /// True when the cursor ran past everything loaded so far. The view model
    /// still checks whether another page can be fetched before declaring the
    /// session finished.
    var isExhausted: Bool { index >= groups.count }

    /// 0…1 for the progress bar. Falls back to the loaded count when the
    /// server total is missing or already overtaken.
    var progress: Double {
        let denominator = max(total, decidedCount, groups.count)
        guard denominator > 0 else { return 0 }
        return min(1, Double(decidedCount) / Double(denominator))
    }

    /// Appends a freshly fetched page, skipping groups already in the list so a
    /// shifted offset can't duplicate a card.
    mutating func append(_ page: [ReviewQueueGroup], total: Int) {
        let known = Set(groups.map(\.id))
        groups.append(contentsOf: page.filter { !known.contains($0.id) })
        self.total = max(total, groups.count)
    }

    mutating func reset(total: Int = 0) {
        groups = []
        index = 0
        decidedCount = 0
        pending = nil
        self.total = total
    }

    /// Records a decision for the current card and advances.
    ///
    /// Returns the *previous* pending decision, which the caller must now send
    /// to the server — it can no longer be undone. Returns nil when this is the
    /// first decision of the session.
    @discardableResult
    mutating func decide(_ kind: ReviewDecision.Kind) -> ReviewDecision? {
        guard let group = current else { return nil }
        let toCommit = pending
        pending = ReviewDecision(group: group, kind: kind)
        index += 1
        decidedCount += 1
        return toCommit
    }

    /// Takes back the decision that was never sent. No-op (false) once it has
    /// been committed, which is what keeps undo honest: it can only revoke
    /// something the server has not seen.
    @discardableResult
    mutating func undo() -> Bool {
        guard pending != nil else { return false }
        pending = nil
        index = max(0, index - 1)
        decidedCount = max(0, decidedCount - 1)
        return true
    }

    /// Hands over the buffered decision for committing and clears it — used
    /// when the queue runs dry or the screen goes away.
    mutating func flush() -> ReviewDecision? {
        defer { pending = nil }
        return pending
    }
}

// MARK: - Swipe mapping

/// The gesture vocabulary of the review card. Kept as a type so the thresholds
/// and the resulting decision are testable without a live gesture recognizer.
enum ReviewSwipe: Equatable, Sendable {
    case keepPick    // → right: accept the suggestion, hide the rest
    case keepAll     // ← left: keep everything, just mark reviewed
    /// ↑ up: favorite the pick *and* accept it. Not a plain "mark as favorite"
    /// — it resolves the group like `keepPick` does, which is why the label
    /// spells both halves out.
    case favorite

    /// Minimum travel before a drag counts as a decision.
    static let threshold: CGFloat = 96

    /// Resolves a finished drag into a decision, or nil when the finger did not
    /// travel far enough. Horizontal movement wins ties so a slightly diagonal
    /// left/right flick doesn't register as "favorite".
    static func resolve(translationWidth dx: CGFloat, translationHeight dy: CGFloat) -> ReviewSwipe? {
        if abs(dx) >= abs(dy) {
            guard abs(dx) >= threshold else { return nil }
            return dx > 0 ? .keepPick : .keepAll
        }
        guard -dy >= threshold else { return nil }
        return .favorite
    }

    /// The decision a swipe produces for a concrete group.
    ///
    /// Without an AI suggestion there is nothing to "accept": a right swipe
    /// then means "keep all", because hiding every member is not a decision the
    /// backend accepts (`pick-photos` requires a non-empty keep set) and would
    /// be a destructive surprise anyway.
    func decision(for group: ReviewQueueGroup) -> ReviewDecision.Kind {
        switch self {
        case .keepAll:
            return .keepAll
        case .keepPick:
            return group.hasAiPick ? .acceptAiPick : .keepAll
        case .favorite:
            return group.hasAiPick ? .favoriteAndAccept : .keepAll
        }
    }

    var label: String {
        switch self {
        case .keepPick:  return "Übernehmen"
        case .keepAll:   return "Alle behalten"
        case .favorite:  return "Favorit & übernehmen"
        }
    }

    /// Spelled-out consequence, shown under the action buttons so the swipe
    /// vocabulary doesn't have to be learned by trial and error.
    var explanation: String {
        switch self {
        case .keepPick: return "KI-Vorschlag behalten, Rest ausblenden"
        case .keepAll:  return "Nichts ausblenden, nur als geprüft markieren"
        case .favorite: return "Vorschlag favorisieren und übernehmen"
        }
    }

    var systemImage: String {
        switch self {
        case .keepPick:  return "checkmark.circle.fill"
        case .keepAll:   return "tray.full.fill"
        case .favorite:  return "heart.fill"
        }
    }
}
