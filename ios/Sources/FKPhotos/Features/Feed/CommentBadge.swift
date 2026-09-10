import Foundation
import Observation
import UserNotifications

/// The number on the home-screen icon: unread comments other people wrote on
/// photos this user can see.
///
/// The badge used to carry the count of unreviewed similar-photo groups,
/// courtesy of the review notice (`ReviewQueueNotifier`). That number never
/// went away on its own — a tidy-up queue is never *finished* — so the icon
/// wore a permanent red count for work nobody had to do today, which is how a
/// badge stops meaning anything. It now stands for the one thing worth
/// chasing off the home screen: somebody said something to you.
///
/// „Unread" is the feed's own `seen_at`, so the badge clears exactly when the
/// Feed tab marks its items seen — no second notion of read-ness to drift out
/// of step with the one the app already has.
@MainActor
@Observable
final class CommentBadge {
    static let shared = CommentBadge()

    /// Nil until the first read finishes, so „not loaded yet" never paints a
    /// badge of its own.
    private(set) var unread: Int?

    private var inFlight: Task<Void, Never>?

    private struct CountResponse: Decodable {
        let count: Int
    }

    /// Read the count and put it on the icon. Concurrent callers share the
    /// one request.
    func refresh() async {
        if let inFlight {
            await inFlight.value
            return
        }
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let response: CountResponse = try await APIClient.shared.get(
                    "/feed/unread-comment-count"
                )
                self.unread = response.count
                await Self.apply(response.count)
            } catch {
                // Leave the icon as it is. A failed read is not „nothing to
                // read", and a badge that clears itself on a flaky connection
                // loses the one comment the user had not seen yet.
            }
        }
        inFlight = task
        await task.value
        inFlight = nil
    }

    /// The feed was opened and its items marked seen — nothing is unread any
    /// more, so clear the icon without waiting for the next fetch.
    func clear() async {
        unread = 0
        await Self.apply(0)
    }

    /// Write the number onto the app icon.
    ///
    /// Setting the badge needs the `.badge` authorization, but asking for it
    /// here would put a permission prompt in front of somebody who has not
    /// met the feature yet. So this only *sets* — the review notice already
    /// asks when it has something to say, and until permission exists the
    /// call is a silent no-op, which is the right failure: no badge.
    private static func apply(_ count: Int) async {
        try? await UNUserNotificationCenter.current().setBadgeCount(max(0, count))
    }
}
