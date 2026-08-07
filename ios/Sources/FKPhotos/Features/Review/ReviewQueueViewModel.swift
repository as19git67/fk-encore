import Foundation

/// Drives the swipe-based group review (issue #761) against the same endpoints
/// the web's "Rapid Review" uses.
///
/// The decision buffer lives in `ReviewQueueState`; this type owns loading,
/// pagination and the network side of committing a decision. Commits are
/// intentionally one step behind the cursor so the newest decision can still be
/// undone — see the comment on `ReviewQueueState`.
@Observable @MainActor
final class ReviewQueueViewModel {
    private(set) var state = ReviewQueueState()
    private(set) var isLoading = false
    private(set) var isLoadingMore = false
    /// Set while a decision is being sent, to keep the card from being swiped
    /// twice into the same request.
    private(set) var isCommitting = false
    private(set) var reachedEnd = false
    var errorMessage: String?
    var toastMessage: ToastMessage?

    /// Confidence stratum the queue is filtered to; nil means "all".
    var confidenceFilter: ReviewConfidence? {
        didSet {
            guard confidenceFilter != oldValue else { return }
            Task { await load() }
        }
    }

    private let pageSize = 20
    /// Groups whose commit failed. They stay unreviewed server-side and simply
    /// reappear in a later session — surfaced so the user isn't told the queue
    /// is done when part of it silently wasn't.
    private(set) var failedCommits = 0

    // MARK: - Loading

    func load() async {
        isLoading = true
        defer { isLoading = false }
        // A pending decision must not be lost just because the filter changed.
        await flush()
        state.reset()
        reachedEnd = false
        failedCommits = 0
        errorMessage = nil
        await fetchPage(offset: 0)
    }

    /// Fetches the next page once the cursor gets close to the end of what is
    /// loaded, so swiping never stalls on a network round trip.
    func loadMoreIfNeeded() async {
        guard !isLoadingMore, !isLoading, !reachedEnd else { return }
        guard state.groups.count - state.index <= 5 else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        await fetchPage(offset: state.groups.count)
    }

    private func fetchPage(offset: Int) async {
        var query = ["offset": String(offset), "limit": String(pageSize)]
        if let confidenceFilter {
            query["confidence"] = confidenceFilter.rawValue
        }
        do {
            let response: ReviewQueueResponse = try await APIClient.shared.get(
                "/photos/groups/review-queue",
                query: query
            )
            let before = state.groups.count
            state.append(response.groups, total: response.total)
            // Nothing new arrived — either the queue is drained or every group
            // on this page was already known. Either way there is no point
            // asking for more.
            if state.groups.count == before { reachedEnd = true }
        } catch {
            errorMessage = error.localizedDescription
            reachedEnd = true
        }
    }

    // MARK: - Decisions

    func apply(_ swipe: ReviewSwipe) {
        guard let group = state.current else { return }
        decide(swipe.decision(for: group))
    }

    /// One-click override: keep exactly this photo and hide the rest.
    func pickOnly(photoId: Int) {
        decide(.pick([photoId]))
    }

    /// Manual override of the AI's pick with an arbitrary keep set (see
    /// `ReviewSelectionSheet`). An empty set is refused rather than sent:
    /// `pick-photos` requires at least one keeper, and hiding a whole group is
    /// not something the review flow should do on a slip.
    func pickPhotos(_ photoIds: [Int]) {
        guard let group = state.current,
              let kind = ReviewDecision.kind(forKeepSet: photoIds, in: group) else { return }
        decide(kind)
    }

    func acceptPeerConsensus() {
        decide(.peerConsensus)
    }

    /// Advances the cursor immediately and hands the now-uncancellable
    /// decision to the commit chain. Deliberately synchronous: the card must
    /// move the instant the finger lifts, never at the speed of the network.
    private func decide(_ kind: ReviewDecision.Kind) {
        guard state.current != nil else { return }
        enqueueCommit(state.decide(kind))
        Task { await loadMoreIfNeeded() }
    }

    /// Takes back the buffered decision. Only ever possible for the most recent
    /// one, because everything older has already reached the server.
    func undo() {
        guard state.undo() else { return }
        toastMessage = .info("Rückgängig gemacht")
    }

    /// Sends whatever is still buffered and waits for the chain to drain. Call
    /// when leaving the screen so the last swipe isn't lost.
    func flush() async {
        enqueueCommit(state.flush())
        await commitChain?.value
    }

    // MARK: - Networking

    private struct EmptyBody: Encodable {}
    private struct SuccessOnly: Decodable { let success: Bool }
    private struct PhotoIdsBody: Encodable { let photoIds: [Int] }
    private struct CurationBody: Encodable { let status: CurationStatus }

    /// Serializes commits behind one another. Decisions are independent
    /// server-side, but keeping them ordered means a failure toast always
    /// refers to the card the user just left rather than an arbitrary one.
    private var commitChain: Task<Void, Never>?

    private func enqueueCommit(_ decision: ReviewDecision?) {
        guard let decision else { return }
        let previous = commitChain
        commitChain = Task { @MainActor [weak self] in
            await previous?.value
            await self?.commit(decision)
        }
    }

    private func commit(_ decision: ReviewDecision) async {
        isCommitting = true
        defer { isCommitting = false }
        do {
            try await send(decision)
        } catch {
            failedCommits += 1
            toastMessage = .error("„\(decision.kind.label)“ konnte nicht gespeichert werden.")
        }
    }

    private func send(_ decision: ReviewDecision) async throws {
        let groupId = decision.group.id
        switch decision.kind {
        case .acceptAiPick:
            _ = try await APIClient.shared.post(
                "/photos/groups/\(groupId)/accept-ai-pick",
                body: EmptyBody()
            ) as SuccessOnly

        case .favoriteAndAccept:
            // Favoriting first matters: accept-ai-pick never clobbers an
            // existing favorite, so the vote survives even if the group's
            // members shift underneath us.
            for photoId in decision.group.pickedPhotoIds {
                _ = try await APIClient.shared.patch(
                    "/photos/\(photoId)/curation",
                    body: CurationBody(status: .favorite)
                ) as SuccessOnly
            }
            _ = try await APIClient.shared.post(
                "/photos/groups/\(groupId)/accept-ai-pick",
                body: EmptyBody()
            ) as SuccessOnly

        case .pick(let photoIds):
            _ = try await APIClient.shared.post(
                "/photos/groups/\(groupId)/pick-photos",
                body: PhotoIdsBody(photoIds: photoIds)
            ) as SuccessOnly

        case .keepAll:
            // Sending the member ids lets the server re-find the group if a
            // background regroup gave it a new id in the meantime.
            _ = try await APIClient.shared.post(
                "/photos/groups/\(groupId)/review",
                body: PhotoIdsBody(photoIds: decision.group.photos.map(\.id))
            ) as SuccessOnly

        case .peerConsensus:
            _ = try await APIClient.shared.post(
                "/photos/groups/\(groupId)/accept-peer-consensus",
                body: EmptyBody()
            ) as SuccessOnly
        }
    }
}
