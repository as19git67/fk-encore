import Foundation
import Observation

/// How many similar-photo groups are still unreviewed — read once, shown
/// everywhere.
///
/// `GET /photos/groups/review-queue` has always answered with `total`; nothing
/// on the phone read it outside the queue screen itself, so every entry point
/// into the review was silent about whether there was anything to do (#968).
/// One request with `limit=1` is enough for the number, so the badge, the hub
/// row and the feed banner cost one call between them rather than one each.
///
/// The count is also kept honest locally: committing a decision drops it by
/// one instead of waiting for the next fetch, so the badge does not still
/// claim seven groups while the user is looking at the sixth.
@MainActor
@Observable
final class ReviewQueueCount {
    static let shared = ReviewQueueCount()

    /// Nil until the first read finishes. „Not loaded" and „nothing open" have
    /// to stay apart: the first must not draw a badge, the second must not
    /// draw one either, but only the second may say „alles durchgesehen".
    private(set) var pending: Int?

    /// The last count this app told the user about, persisted so a growth
    /// notification survives a relaunch rather than firing again for groups
    /// already announced.
    private(set) var lastNotified: Int?

    private var inFlight: Task<Void, Never>?
    private let defaults: UserDefaults
    private static let lastNotifiedKey = "review-queue-last-notified-count"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // `object(forKey:)` rather than `integer(forKey:)`: a missing value has
        // to stay nil, and 0 is a real count.
        self.lastNotified = defaults.object(forKey: Self.lastNotifiedKey) as? Int
    }

    /// Read the count. Concurrent callers share the one request.
    func refresh() async {
        if let inFlight {
            await inFlight.value
            return
        }
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let response: ReviewQueueResponse = try await APIClient.shared.get(
                    "/photos/groups/review-queue",
                    query: ["offset": "0", "limit": "1"]
                )
                self.pending = response.total
            } catch {
                // Leave the previous number standing rather than dropping to
                // zero: a failed read is not „nothing to review", and a badge
                // that vanishes on a flaky connection is worse than a stale one.
            }
        }
        inFlight = task
        await task.value
        inFlight = nil
    }

    /// One group has been decided.
    func noteDecided(count: Int = 1) {
        guard let pending else { return }
        self.pending = max(0, pending - count)
    }

    /// An undo put a group back.
    func noteUndone(count: Int = 1) {
        guard let pending else { return }
        self.pending = pending + count
    }

    /// Remember what the user has been told, so the same groups are not
    /// announced twice.
    func recordNotified(_ count: Int) {
        lastNotified = count
        defaults.set(count, forKey: Self.lastNotifiedKey)
    }

    /// Called when the queue is opened: whatever is on screen has been seen,
    /// so a later notification should only be about what arrives *after* this.
    func recordSeen() {
        guard let pending else { return }
        recordNotified(pending)
    }
}
