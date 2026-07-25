import Foundation

/// Filter controlling which server photos are downloaded to iOS.
enum DownloadFavoritesFilter: String, CaseIterable {
    /// Download all visible photos regardless of favorite status.
    case all = "all"
    /// Only photos the current user has marked as favorite.
    case myFavorites = "mine"
    /// Photos favorited by anyone (current user or other album members).
    case anyFavorite = "any"

    var label: String {
        switch self {
        case .all:         return "Alle Fotos"
        case .myFavorites: return "Nur meine Favoriten"
        case .anyFavorite: return "Favoriten (alle)"
        }
    }
}

/// Namespace for all download-sync UserDefaults keys and typed accessors.
struct DownloadSyncPreferences {
    private init() {}

    static let taskIdentifier = "dev.fk-encore.F4milPhotos.photoDownload"

    // MARK: - Keys

    private static let enabledKey          = "download.enabled"
    private static let wifiOnlyKey         = "download.wifiOnly"
    private static let selectedAlbumsKey   = "download.selectedAlbumIds"
    private static let favFilterKey        = "download.favoritesFilter"
    private static let includeHiddenKey    = "download.includeHidden"
    private static let lastSyncDateKey     = "download.lastSyncDate"
    private static let downloadedPhotosKey = "download.downloadedPhotos"
    // Per-photo sync-state cache: keyed by "<albumId>:<photoId>", stores the
    // server's hash and updated_at value at the time of the last sync. Used to
    // detect when the server's metadata or pixel data have moved and the local
    // copy needs refreshing (issue #303).
    private static let downloadedStateKey  = "download.downloadedState"
    // Last ETag observed on /photos/index. When the next sync run sends this
    // back via If-None-Match and the server replies 304 Not Modified we know
    // nothing changed in the user's library and the per-album walk can be
    // skipped entirely (issue #303 phase 5).
    private static let lastIndexETagKey    = "download.lastIndexETag"

    // MARK: - Settings

    static var downloadEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: enabledKey) }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }

    /// Restrict downloads to WiFi connections. Default: true.
    static var wifiOnly: Bool {
        get { (UserDefaults.standard.object(forKey: wifiOnlyKey) as? Bool) ?? true }
        set { UserDefaults.standard.set(newValue, forKey: wifiOnlyKey) }
    }

    /// Server album IDs to sync to iOS.
    static var selectedServerAlbumIds: Set<Int> {
        get { Set(UserDefaults.standard.array(forKey: selectedAlbumsKey) as? [Int] ?? []) }
        set { UserDefaults.standard.set(Array(newValue), forKey: selectedAlbumsKey) }
    }

    static var favoritesFilter: DownloadFavoritesFilter {
        get {
            let raw = UserDefaults.standard.string(forKey: favFilterKey) ?? "all"
            return DownloadFavoritesFilter(rawValue: raw) ?? .all
        }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: favFilterKey) }
    }

    /// Include photos the current user has hidden. Default: false.
    static var includeHidden: Bool {
        get { UserDefaults.standard.bool(forKey: includeHiddenKey) }
        set { UserDefaults.standard.set(newValue, forKey: includeHiddenKey) }
    }

    // MARK: - Status

    static var lastDownloadDate: Date? {
        get { UserDefaults.standard.object(forKey: lastSyncDateKey) as? Date }
        set { UserDefaults.standard.set(newValue, forKey: lastSyncDateKey) }
    }

    // MARK: - Downloaded photo tracking
    //
    // Structure stored in UserDefaults:
    //   [albumId (String) : [serverPhotoId (String) : iOS localIdentifier (String)]]
    //
    // This lets us detect photos removed from a server album so we can move the
    // corresponding iOS asset to "F4mil Trash" rather than silently leaving it
    // in the synced album.

    static func loadDownloadedPhotos() -> [String: [String: String]] {
        UserDefaults.standard.dictionary(forKey: downloadedPhotosKey)
            as? [String: [String: String]] ?? [:]
    }

    static func saveDownloadedPhotos(_ mapping: [String: [String: String]]) {
        UserDefaults.standard.set(mapping, forKey: downloadedPhotosKey)
    }

    /// Drops photos from the download tracking for an album without moving the
    /// local asset to trash. Called from the upload-side deletion pass in bisync
    /// mode: when the user removes a photo from the iOS album, delete-up removes
    /// it from the server album, and this forgets it here so the download pass
    /// treats it as gone-on-purpose rather than server-removed (which would move
    /// the still-present local asset into "F4mil Trash").
    static func forgetDownloadedPhotos(albumId: Int, photoIds: [Int]) {
        guard !photoIds.isEmpty else { return }
        let albumKey = String(albumId)
        var photos = loadDownloadedPhotos()
        guard var album = photos[albumKey] else { return }
        var state = loadDownloadedState()
        for pid in photoIds {
            album.removeValue(forKey: String(pid))
            state.removeValue(forKey: stateKey(albumId: albumId, photoId: pid))
        }
        photos[albumKey] = album
        saveDownloadedPhotos(photos)
        saveDownloadedState(state)
    }

    static func resetDownloadHistory() {
        UserDefaults.standard.removeObject(forKey: downloadedPhotosKey)
        UserDefaults.standard.removeObject(forKey: lastSyncDateKey)
        UserDefaults.standard.removeObject(forKey: downloadedStateKey)
    }

    static var downloadedCount: Int {
        loadDownloadedPhotos().values.reduce(0) { $0 + $1.count }
    }

    // MARK: - Per-photo sync state (issue #303)

    /// Server-side state we last applied to the local copy of a photo.
    /// Used by PhotoDownloadService to skip work when nothing moved and to
    /// refresh metadata / pixel data when something did.
    struct DownloadedPhotoState: Codable, Hashable, Sendable {
        /// Full/state hash (changes on any edit). Kept for change-detection but
        /// NOT used to decide pixel changes — see `imageDataHash`.
        let hash: String?
        /// Pixel-only hash: decides whether the local asset must be
        /// re-downloaded. Optional (nil for legacy state / legacy server rows) —
        /// a nil on either side is treated as "pixels unchanged" so a metadata
        /// edit never triggers a re-download + delete.
        let imageDataHash: String?
        let updatedAt: String?
        let takenAt: String?
        let isFavorite: Bool
        /// Server-side description, so a caption change can be applied in place
        /// (content edit) instead of re-downloading.
        let caption: String?
    }

    /// Returns the entire state map keyed by "<albumId>:<photoId>".
    static func loadDownloadedState() -> [String: DownloadedPhotoState] {
        guard let data = UserDefaults.standard.data(forKey: downloadedStateKey),
              let decoded = try? JSONDecoder().decode([String: DownloadedPhotoState].self, from: data)
        else {
            return [:]
        }
        return decoded
    }

    static func saveDownloadedState(_ state: [String: DownloadedPhotoState]) {
        if let data = try? JSONEncoder().encode(state) {
            UserDefaults.standard.set(data, forKey: downloadedStateKey)
        }
    }

    static func stateKey(albumId: Int, photoId: Int) -> String {
        "\(albumId):\(photoId)"
    }

    static var lastIndexETag: String? {
        get { UserDefaults.standard.string(forKey: lastIndexETagKey) }
        set {
            if let v = newValue {
                UserDefaults.standard.set(v, forKey: lastIndexETagKey)
            } else {
                UserDefaults.standard.removeObject(forKey: lastIndexETagKey)
            }
        }
    }
}
