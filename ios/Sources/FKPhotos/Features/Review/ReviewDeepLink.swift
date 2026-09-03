import Foundation

/// Where an incoming URL wants to go.
///
/// The feed banner and the notification both need one target to point at, and
/// a notification tap has to work from a cold launch — which is a URL, not a
/// view (#968, proposal 6). Parsing is pure so the accepted and rejected
/// shapes are testable without an app around them.
///
/// The scheme is registered in `Info.plist` (`CFBundleURLTypes`). Universal
/// links would need an `apple-app-site-association` file served from the
/// household's own domain; the scheme works without any server change, and the
/// routing below is the same either way.
enum ReviewDeepLink: Equatable, Sendable {
    /// `f4milphotos://review-queue`
    case reviewQueue

    static let scheme = "f4milphotos"
    static let reviewQueueHost = "review-queue"

    /// The URL that opens the review queue. Used by the notification, which
    /// cannot hold a view.
    static var reviewQueueURL: URL {
        URL(string: "\(scheme)://\(reviewQueueHost)")!
    }

    /// Read a URL the system handed us.
    ///
    /// Only this app's own scheme is accepted, and only hosts it knows: an
    /// unknown path must open the app on whatever it was showing rather than
    /// somewhere arbitrary.
    static func parse(_ url: URL) -> ReviewDeepLink? {
        guard url.scheme?.lowercased() == scheme else { return nil }
        // `f4milphotos://review-queue` puts it in the host;
        // `f4milphotos:/review-queue` and `f4milphotos:review-queue` put it in
        // the path. Accept all three rather than depending on how the link was
        // typed or generated.
        let candidates = [
            url.host?.lowercased(),
            url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")).lowercased(),
            url.absoluteString
                .dropFirst("\(scheme):".count)
                .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                .lowercased()
        ].compactMap { $0 }.filter { !$0.isEmpty }

        guard candidates.contains(reviewQueueHost) else { return nil }
        return .reviewQueue
    }
}

/// Where a deep link lands, independent of the tab bar.
///
/// The review queue is not any tab's own screen — the entry points that lead
/// to it (feed banner, hub row, toolbar badge) all push it locally, but a
/// notification tap or a cold-launch URL has no tab context to push from.
/// This is a single switch `ContentView` presents over whatever tab is
/// showing, so „open the review queue" means the same thing regardless of
/// where the app happened to be.
@MainActor
@Observable
public final class ReviewDeepLinkRouter {
    // `Main.swift` (a separate module — the App target's own Package.swift
    // build never compiles it, which is how this stayed internal and broke
    // the app build without CI noticing) calls `.shared.handle(_:)` from its
    // notification-tap delegate, so both have to be public.
    public static let shared = ReviewDeepLinkRouter()

    var isPresentingReviewQueue = false

    public func handle(_ url: URL) {
        guard ReviewDeepLink.parse(url) == .reviewQueue else { return }
        isPresentingReviewQueue = true
    }
}

