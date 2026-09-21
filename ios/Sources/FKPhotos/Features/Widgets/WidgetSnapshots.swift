import Foundation
import WidgetKit

/// Small, precomputed answers for the home-screen widgets (#764): "On
/// this day", the latest recap, and recent feed activity.
///
/// The widget extension has no session of its own and must not need
/// one — it never calls the API. So the main app writes these at its
/// own natural refresh points (the recap list loading, the feed
/// loading) into the App Group `UserDefaults` suite the Share
/// Extension already uses (`SharedStorage`), and the extension only
/// ever reads.
///
/// Text-first, on purpose: no thumbnail travels with these yet. The
/// disk image cache added for #1293 lives in the app's own private
/// Caches directory, which the extension's sandbox cannot see, and
/// giving the widgets a photo means first giving them a shared place
/// to keep one. A widget that shows the app icon and a line of text is
/// still useful without that — it is the fast-follow, not a blocker.
public enum WidgetSnapshotStore {
    private static let onThisDayKey = "widgets.onThisDay"
    private static let latestRecapKey = "widgets.latestRecap"
    private static let recentFeedKey = "widgets.recentFeed"

    // MARK: - Writers (main app only)

    /// Reads the same list the recaps screen just loaded and updates
    /// both recap-based widgets from it — one fetch, two answers,
    /// exactly the "why ask twice" rule the rest of the app follows.
    /// Not `public`: only `RecapsViewModel`, in this module, calls it —
    /// a public function could not mention `RecapSummary`, which is not.
    static func updateFromRecaps(_ recaps: [RecapSummary], defaults: UserDefaults = SharedStorage.defaults) {
        // The same "what to show" a tap on the recap list icon would —
        // the newest one still waiting to be seen, or failing that the
        // newest of any kind.
        let latest = recaps.first { $0.dismissed_at == nil } ?? recaps.first
        save(latest.map(LatestRecapSnapshot.init), key: latestRecapKey, defaults: defaults)

        // "On this day" is its own widget only when there is one
        // waiting — a widget insisting there is a memory when the
        // server made none for today would be worse than a plain
        // placeholder.
        let onThisDay = recaps.first { $0.recapKind == .onThisDay && $0.dismissed_at == nil }
        save(onThisDay.map(OnThisDaySnapshot.init), key: onThisDayKey, defaults: defaults)

        WidgetCenter.shared.reloadTimelines(ofKind: WidgetKinds.latestRecap)
        WidgetCenter.shared.reloadTimelines(ofKind: WidgetKinds.onThisDay)
    }

    /// The newest item the feed screen just loaded, for the "recent
    /// feed activity" widget. Only ever the newest: a widget is a
    /// glance, not a second feed. Not `public`, for the same reason as
    /// `updateFromRecaps`.
    static func updateFromFeed(_ items: [FeedPhotoItem], defaults: UserDefaults = SharedStorage.defaults) {
        save(items.first.map(RecentFeedSnapshot.init), key: recentFeedKey, defaults: defaults)
        WidgetCenter.shared.reloadTimelines(ofKind: WidgetKinds.recentFeed)
    }

    // MARK: - Readers (widget extension and app alike)

    public static func loadOnThisDay(defaults: UserDefaults = SharedStorage.defaults) -> OnThisDaySnapshot? {
        load(key: onThisDayKey, defaults: defaults)
    }

    public static func loadLatestRecap(defaults: UserDefaults = SharedStorage.defaults) -> LatestRecapSnapshot? {
        load(key: latestRecapKey, defaults: defaults)
    }

    public static func loadRecentFeed(defaults: UserDefaults = SharedStorage.defaults) -> RecentFeedSnapshot? {
        load(key: recentFeedKey, defaults: defaults)
    }

    // MARK: - Storage

    private static func save<T: Encodable>(_ value: T?, key: String, defaults: UserDefaults) {
        guard let value, let data = try? JSONEncoder().encode(value) else {
            defaults.removeObject(forKey: key)
            return
        }
        defaults.set(data, forKey: key)
    }

    private static func load<T: Decodable>(key: String, defaults: UserDefaults) -> T? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}

/// The widget kinds' `String` identifiers — shared between the
/// `Widget`s themselves (declared in the extension, which this
/// package cannot see) and the reload calls above, so the two never
/// drift apart under two different literals.
public enum WidgetKinds {
    public static let onThisDay = "OnThisDayWidget"
    public static let latestRecap = "LatestRecapWidget"
    public static let recentFeed = "RecentFeedWidget"
}

public struct OnThisDaySnapshot: Codable, Sendable {
    public let title: String
    public let subtitle: String?
    public let recapId: Int

    init(_ recap: RecapSummary) {
        title = recap.title
        subtitle = recap.subtitle
        recapId = recap.id
    }
}

public struct LatestRecapSnapshot: Codable, Sendable {
    public let title: String
    public let subtitle: String?
    public let recapId: Int
    public let isOnThisDay: Bool

    init(_ recap: RecapSummary) {
        title = recap.title
        subtitle = recap.subtitle
        recapId = recap.id
        isOnThisDay = recap.recapKind == .onThisDay
    }
}

public struct RecentFeedSnapshot: Codable, Sendable {
    public let photoId: Int
    /// Never invented: the owner's own name, or nothing (§15.3 applies
    /// here as much as it does to a place with no name).
    public let ownerName: String?
    public let albumName: String?
    /// ISO-8601, so the widget can phrase "vor 2 Stunden" itself
    /// without a stale string baked in at write time.
    public let lastActivityAt: String

    init(_ item: FeedPhotoItem) {
        photoId = item.photoId
        ownerName = item.owner.name
        albumName = item.album?.name
        lastActivityAt = item.lastActivityAt
    }
}
