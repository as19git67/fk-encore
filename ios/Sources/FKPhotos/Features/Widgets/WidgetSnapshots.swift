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
/// Each snapshot may name a photo file in `WidgetImageStore` — the
/// recap's cover, the feed item itself — that the widget shows as its
/// background. The disk image cache (#1293) lives in the app's own
/// private Caches directory, which the extension's sandbox cannot see,
/// so the app writes a small copy into the App Group container instead.
/// Text and image are written in two steps: the text the moment the
/// list is in (so the widget is never behind the app), the image after
/// one more download, and a snapshot whose image is still the same
/// photo keeps its file rather than fetching it again.
public enum WidgetSnapshotStore {
    private static let onThisDayKey = "widgets.onThisDay"
    private static let latestRecapKey = "widgets.latestRecap"
    private static let recentFeedKey = "widgets.recentFeed"

    /// Fetches the bytes of one photo, by filename. Injectable so the
    /// tests can hand over a JPEG without a server.
    typealias PhotoFetcher = @Sendable (_ filename: String) async throws -> Data

    /// The app's own fetch: the server's resized JPEG, small enough
    /// for a widget, converted from HEIC where needed.
    static let defaultFetcher: PhotoFetcher = { filename in
        try await APIClient.shared.downloadData(
            "/photos/file/\(filename)",
            query: ["w": String(Int(WidgetImageStore.maxPixelSize)), "convert": "true"]
        )
    }

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
        let previousLatest: LatestRecapSnapshot? = load(key: latestRecapKey, defaults: defaults)
        save(
            latest.map { LatestRecapSnapshot($0, imageFile: previousLatest?.imageFile(ifCover: $0.cover_photo_id)) },
            key: latestRecapKey, defaults: defaults
        )

        // "On this day" is its own widget only when there is one
        // waiting — a widget insisting there is a memory when the
        // server made none for today would be worse than a plain
        // placeholder.
        let onThisDay = recaps.first { $0.recapKind == .onThisDay && $0.dismissed_at == nil }
        let previousOnThisDay: OnThisDaySnapshot? = load(key: onThisDayKey, defaults: defaults)
        save(
            onThisDay.map { OnThisDaySnapshot($0, imageFile: previousOnThisDay?.imageFile(ifCover: $0.cover_photo_id)) },
            key: onThisDayKey, defaults: defaults
        )

        WidgetCenter.shared.reloadTimelines(ofKind: WidgetKinds.latestRecap)
        WidgetCenter.shared.reloadTimelines(ofKind: WidgetKinds.onThisDay)
    }

    /// The newest item the feed screen just loaded, for the "recent
    /// feed activity" widget. Only ever the newest: a widget is a
    /// glance, not a second feed. Not `public`, for the same reason as
    /// `updateFromRecaps`.
    static func updateFromFeed(_ items: [FeedPhotoItem], defaults: UserDefaults = SharedStorage.defaults) {
        let previous: RecentFeedSnapshot? = load(key: recentFeedKey, defaults: defaults)
        save(
            items.first.map { RecentFeedSnapshot($0, imageFile: previous?.imageFile(ifPhoto: $0.photoId)) },
            key: recentFeedKey, defaults: defaults
        )
        WidgetCenter.shared.reloadTimelines(ofKind: WidgetKinds.recentFeed)
    }

    // MARK: - Images (main app only)

    /// Gives the two recap widgets their cover photo, after
    /// `updateFromRecaps` has written the text. `coverFilenames` is what
    /// the recap list resolved for its own thumbnails (cover photo id to
    /// filename). A widget whose snapshot already names a file for the
    /// same cover is left alone; a download that fails leaves the text
    /// in place and the widget without a photo, as before.
    static func updateRecapImages(
        coverFilenames: [Int: String],
        defaults: UserDefaults = SharedStorage.defaults,
        images: WidgetImageStore = .shared,
        fetch: PhotoFetcher = Self.defaultFetcher
    ) async {
        if var snapshot: LatestRecapSnapshot = load(key: latestRecapKey, defaults: defaults) {
            if let file = await imageFile(
                current: snapshot.imageFile, photoId: snapshot.coverPhotoId,
                filenames: coverFilenames, widget: WidgetKinds.latestRecap, images: images, fetch: fetch
            ), file != snapshot.imageFile {
                snapshot.imageFile = file
                save(snapshot, key: latestRecapKey, defaults: defaults)
                WidgetCenter.shared.reloadTimelines(ofKind: WidgetKinds.latestRecap)
            }
        } else {
            images.remove(widget: WidgetKinds.latestRecap)
        }

        if var snapshot: OnThisDaySnapshot = load(key: onThisDayKey, defaults: defaults) {
            if let file = await imageFile(
                current: snapshot.imageFile, photoId: snapshot.coverPhotoId,
                filenames: coverFilenames, widget: WidgetKinds.onThisDay, images: images, fetch: fetch
            ), file != snapshot.imageFile {
                snapshot.imageFile = file
                save(snapshot, key: onThisDayKey, defaults: defaults)
                WidgetCenter.shared.reloadTimelines(ofKind: WidgetKinds.onThisDay)
            }
        } else {
            images.remove(widget: WidgetKinds.onThisDay)
        }
    }

    /// The feed widget's photo, after `updateFromFeed` wrote the text.
    /// The feed item carries its own filename, so nothing needs
    /// resolving first.
    static func updateFeedImage(
        filename: String?,
        defaults: UserDefaults = SharedStorage.defaults,
        images: WidgetImageStore = .shared,
        fetch: PhotoFetcher = Self.defaultFetcher
    ) async {
        guard var snapshot: RecentFeedSnapshot = load(key: recentFeedKey, defaults: defaults) else {
            images.remove(widget: WidgetKinds.recentFeed)
            return
        }
        let filenames = filename.map { [snapshot.photoId: $0] } ?? [:]
        if let file = await imageFile(
            current: snapshot.imageFile, photoId: snapshot.photoId,
            filenames: filenames, widget: WidgetKinds.recentFeed, images: images, fetch: fetch
        ), file != snapshot.imageFile {
            snapshot.imageFile = file
            save(snapshot, key: recentFeedKey, defaults: defaults)
            WidgetCenter.shared.reloadTimelines(ofKind: WidgetKinds.recentFeed)
        }
    }

    /// The file a widget should name for `photoId`: the one it already
    /// has if that is still on disk, else a fresh download. Nil when
    /// there is no photo to show or the download failed.
    private static func imageFile(
        current: String?,
        photoId: Int?,
        filenames: [Int: String],
        widget: String,
        images: WidgetImageStore,
        fetch: PhotoFetcher
    ) async -> String? {
        guard let photoId else {
            images.remove(widget: widget)
            return nil
        }
        if let current, current == WidgetImageStore.fileName(widget: widget, photoId: photoId),
           images.contains(current) {
            return current
        }
        guard let filename = filenames[photoId], let data = try? await fetch(filename) else { return nil }
        return images.store(data, widget: widget, photoId: photoId)
    }

    /// Forgets everything the widgets show — snapshots and photos — and
    /// tells them to redraw. On sign-out: the extension never checks a
    /// session, so without this the home screen keeps showing the last
    /// account's photo and names, to whoever signs in next.
    static func clearAll(
        defaults: UserDefaults = SharedStorage.defaults,
        images: WidgetImageStore = .shared
    ) {
        for key in [onThisDayKey, latestRecapKey, recentFeedKey] {
            defaults.removeObject(forKey: key)
        }
        for widget in [WidgetKinds.onThisDay, WidgetKinds.latestRecap, WidgetKinds.recentFeed] {
            images.remove(widget: widget)
        }
        WidgetCenter.shared.reloadAllTimelines()
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
    /// The recap's cover photo, if the server chose one. Optional in the
    /// stored JSON too, so a snapshot written before it existed still
    /// decodes.
    public var coverPhotoId: Int?
    /// The cover as a file in `WidgetImageStore`, once downloaded.
    public var imageFile: String?

    init(_ recap: RecapSummary, imageFile: String? = nil) {
        title = recap.title
        subtitle = recap.subtitle
        recapId = recap.id
        coverPhotoId = recap.cover_photo_id
        self.imageFile = imageFile
    }

    /// The stored image, but only if it is the cover of `coverPhotoId`
    /// — a new recap in the same slot must not inherit the old photo.
    func imageFile(ifCover coverPhotoId: Int?) -> String? {
        coverPhotoId != nil && coverPhotoId == self.coverPhotoId ? imageFile : nil
    }
}

public struct LatestRecapSnapshot: Codable, Sendable {
    public let title: String
    public let subtitle: String?
    public let recapId: Int
    public let isOnThisDay: Bool
    public var coverPhotoId: Int?
    public var imageFile: String?

    init(_ recap: RecapSummary, imageFile: String? = nil) {
        title = recap.title
        subtitle = recap.subtitle
        recapId = recap.id
        isOnThisDay = recap.recapKind == .onThisDay
        coverPhotoId = recap.cover_photo_id
        self.imageFile = imageFile
    }

    func imageFile(ifCover coverPhotoId: Int?) -> String? {
        coverPhotoId != nil && coverPhotoId == self.coverPhotoId ? imageFile : nil
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
    /// The photo itself as a file in `WidgetImageStore`, once downloaded.
    public var imageFile: String?

    init(_ item: FeedPhotoItem, imageFile: String? = nil) {
        photoId = item.photoId
        ownerName = item.owner.name
        albumName = item.album?.name
        lastActivityAt = item.lastActivityAt
        self.imageFile = imageFile
    }

    func imageFile(ifPhoto photoId: Int) -> String? {
        photoId == self.photoId ? imageFile : nil
    }
}
