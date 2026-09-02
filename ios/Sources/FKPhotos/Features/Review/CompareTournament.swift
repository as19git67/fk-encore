import Foundation

/// Comparing a whole group of near-duplicates, two photos at a time.
///
/// The web's `PhotoCompareView` is a Swiss-system tournament: a verdict on one
/// pair moves two scores, marks that *pair* as settled, and the next pair is
/// the closest-scoring one still unseen. Only when the pairs run out does it
/// move to a confirmation phase, where the resulting keep set is shown and
/// committed **once**.
///
/// iOS had none of that. `PhotoCompareView` was handed two photos — the group's
/// two leading candidates — and the first fling committed a decision for the
/// entire group, so the other members were never compared at all (#1085 §2a).
///
/// This is that loop, as a value: no view, no network, so the ordering rules
/// and the keep set can be tested directly.
struct CompareTournament: Equatable, Sendable {

    /// Which half of the tournament we are in.
    enum Phase: Equatable, Sendable {
        /// Still comparing pairs.
        case comparing
        /// Every pair settled — the keep set is up for confirmation.
        case confirming
    }

    /// A pair, always stored with the smaller id first so „7 against 9" and
    /// „9 against 7" are the same pair and cannot be judged twice.
    struct Pair: Hashable, Sendable {
        let low: Int
        let high: Int

        init(_ a: Int, _ b: Int) {
            low = min(a, b)
            high = max(a, b)
        }

        var ids: (Int, Int) { (low, high) }

        func contains(_ id: Int) -> Bool { id == low || id == high }

        /// The other photo in the pair, or nil if `id` is not in it.
        func other(than id: Int) -> Int? {
            if id == low { return high }
            if id == high { return low }
            return nil
        }
    }

    /// The group, in the order the panes should show it.
    private(set) var photoIds: [Int]
    /// Higher means „keep". A verdict moves the winner up and the loser down.
    private(set) var scores: [Int: Int]
    private(set) var settled: Set<Pair>
    private(set) var current: Pair?
    private(set) var phase: Phase
    /// How many verdicts have been given, for the progress line.
    private(set) var comparisons: Int

    /// A pair the user asked to skip. Not settled — it can come back — but not
    /// offered again while another pair is available.
    private var skipped: Set<Pair>

    // MARK: - Starting

    init(photoIds: [Int], seedScores: [Int: Int] = [:]) {
        self.photoIds = photoIds
        self.scores = Dictionary(
            uniqueKeysWithValues: photoIds.map { ($0, seedScores[$0] ?? 0) }
        )
        self.settled = []
        self.skipped = []
        self.comparisons = 0
        self.current = nil
        self.phase = .comparing
        // A group of one has nothing to compare, and goes straight to the
        // confirmation — which is the honest answer, not an error.
        if let first = Self.nextPair(
            photoIds: photoIds, scores: scores, excluding: []
        ) {
            self.current = first
        } else {
            self.phase = .confirming
        }
    }

    // MARK: - Verdicts

    /// One photo loses to its partner.
    mutating func discard(_ photoId: Int) {
        guard let pair = current, let winner = pair.other(than: photoId) else { return }
        scores[photoId] = (scores[photoId] ?? 0) - 1
        scores[winner] = (scores[winner] ?? 0) + 1
        settle(pair)
    }

    /// Neither is better. The pair is done; no score moves.
    mutating func draw() {
        guard let pair = current else { return }
        settle(pair)
    }

    /// „Not this one now." The pair stays unjudged and is offered again once
    /// nothing else is left, rather than being lost.
    mutating func skip() {
        guard let pair = current else { return }
        skipped.insert(pair)
        advance()
    }

    private mutating func settle(_ pair: Pair) {
        settled.insert(pair)
        skipped.remove(pair)
        comparisons += 1
        advance()
    }

    private mutating func advance() {
        if let next = Self.nextPair(
            photoIds: photoIds, scores: scores, excluding: settled.union(skipped)
        ) {
            current = next
            return
        }
        // Nothing fresh left: a skipped pair is better than ending early, so
        // those come back before the tournament closes.
        if let revisited = Self.nextPair(
            photoIds: photoIds, scores: scores, excluding: settled
        ) {
            current = revisited
            return
        }
        current = nil
        phase = .confirming
    }

    /// End the pairwise half early — the user has seen enough.
    mutating func finishComparing() {
        current = nil
        phase = .confirming
    }

    // MARK: - Reading

    /// Whether any pair at all is still unjudged.
    var hasUnsettledPairs: Bool {
        Self.nextPair(photoIds: photoIds, scores: scores, excluding: settled) != nil
    }

    /// Total unique pairs in the group: n · (n − 1) / 2.
    var totalPairs: Int {
        let n = photoIds.count
        return n < 2 ? 0 : n * (n - 1) / 2
    }

    func score(of photoId: Int) -> Int { scores[photoId] ?? 0 }

    /// The group ordered best first, which is how the confirmation lists it.
    /// Ties keep the group's own order, so the list does not reshuffle between
    /// verdicts that changed nothing about them.
    var ranked: [Int] {
        let position = Dictionary(
            uniqueKeysWithValues: photoIds.enumerated().map { ($1, $0) }
        )
        return photoIds.sorted { lhs, rhs in
            let l = score(of: lhs), r = score(of: rhs)
            if l != r { return l > r }
            return (position[lhs] ?? 0) < (position[rhs] ?? 0)
        }
    }

    /// What the tournament proposes to keep: everything that did not end up
    /// below zero.
    ///
    /// A photo only goes negative by losing more comparisons than it won, so a
    /// group nobody judged proposes keeping all of it — never „hide the lot"
    /// off the back of no evidence. `pick-photos` also needs at least one
    /// keeper, so a clean sweep falls back to the best-ranked photo.
    var suggestedKeepIds: [Int] {
        let kept = photoIds.filter { score(of: $0) >= 0 }
        if kept.isEmpty, let best = ranked.first { return [best] }
        return kept
    }

    // MARK: - Pair selection

    /// The next pair to show: the closest-scoring one not yet excluded.
    ///
    /// Closest first is what makes the tournament short — comparing a photo
    /// that has won everything against one that has lost everything tells you
    /// nothing you did not already know. Ties are broken by the pair's ids so
    /// the same group always produces the same order.
    static func nextPair(
        photoIds: [Int],
        scores: [Int: Int],
        excluding: Set<Pair>
    ) -> Pair? {
        guard photoIds.count >= 2 else { return nil }
        var best: Pair?
        var bestDifference = Int.max
        for i in photoIds.indices {
            for j in (i + 1)..<photoIds.count {
                let pair = Pair(photoIds[i], photoIds[j])
                guard !excluding.contains(pair) else { continue }
                let difference = abs(
                    (scores[photoIds[i]] ?? 0) - (scores[photoIds[j]] ?? 0)
                )
                if difference < bestDifference {
                    bestDifference = difference
                    best = pair
                }
            }
        }
        return best
    }

    /// Scores to start from, derived from the AI's quality ratings.
    ///
    /// The mapping is the web's: 0.0 → −3, 0.5 → 0, 1.0 → +3. When every photo
    /// in the group scores within a hair of the others (a range under 0.12 —
    /// which is the normal case for a burst), the absolute mapping flattens
    /// them all to the same number and says nothing, so the scores are
    /// normalized within the group instead: worst → −3, best → +3.
    ///
    /// An unscored photo sits at 0, which is „no opinion" rather than „bad".
    static func seedScores(qualities: [Int: Double?]) -> [Int: Int] {
        let scored = qualities.compactMapValues { $0 }
        var useRelative = false
        var minimum = 0.0
        var range = 0.0
        if scored.count >= 2 {
            minimum = scored.values.min() ?? 0
            let maximum = scored.values.max() ?? 0
            range = maximum - minimum
            useRelative = range > 0 && range < 0.12
        }
        var seeds: [Int: Int] = [:]
        for (id, quality) in qualities {
            guard let quality else {
                seeds[id] = 0
                continue
            }
            if useRelative {
                let relative = (quality - minimum) / range
                seeds[id] = Int(((relative - 0.5) * 6).rounded())
            } else {
                seeds[id] = Int(((quality - 0.5) * 6).rounded())
            }
        }
        return seeds
    }
}
