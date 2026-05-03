import Foundation

/// Possible album source modes for the photo sync.
enum SyncAlbumMode: String {
    case all = "all"
    case selected = "selected"
}

/// Namespace for all sync-related UserDefaults keys and typed accessors.
/// Thread-safe through UserDefaults's own serialization.
struct PhotoSyncPreferences {
    private init() {}

    static let taskIdentifier = "dev.fk-encore.VivantyPhotos.photoSync"

    // MARK: - Keys

    private static let enabledKey          = "sync.enabled"
    private static let albumModeKey        = "sync.albumMode"
    private static let selectedAlbumsKey   = "sync.selectedAlbumIds"
    private static let onlyNewKey          = "sync.onlyNew"
    private static let wifiOnlyKey         = "sync.wifiOnly"
    private static let lastSyncDateKey     = "sync.lastSyncDate"
    private static let uploadedIdsKey      = "sync.uploadedIds"
    private static let allPhotosAlbumIdKey = "sync.allPhotosAlbumId"
    private static let albumMappingsKey    = "sync.albumMappings"
    private static let serverPhotoMapKey    = "sync.serverPhotoMap"
    private static let excludeScreenshotsKey = "sync.excludeScreenshots"
    private static let syncedFavoriteIdsKey = "sync.syncedFavoriteIds"

    // MARK: - Settings

    static var syncEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: enabledKey) }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }

    static var albumMode: SyncAlbumMode {
        get {
            let raw = UserDefaults.standard.string(forKey: albumModeKey) ?? "all"
            return SyncAlbumMode(rawValue: raw) ?? .all
        }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: albumModeKey) }
    }

    static var selectedAlbumIds: Set<String> {
        get { Set(UserDefaults.standard.stringArray(forKey: selectedAlbumsKey) ?? []) }
        set { UserDefaults.standard.set(Array(newValue), forKey: selectedAlbumsKey) }
    }

    /// Upload only photos taken after the last sync date. Default: true.
    static var onlyNew: Bool {
        get { (UserDefaults.standard.object(forKey: onlyNewKey) as? Bool) ?? true }
        set { UserDefaults.standard.set(newValue, forKey: onlyNewKey) }
    }

    /// Exclude screenshots from uploads. Default: true.
    static var excludeScreenshots: Bool {
        get { (UserDefaults.standard.object(forKey: excludeScreenshotsKey) as? Bool) ?? true }
        set { UserDefaults.standard.set(newValue, forKey: excludeScreenshotsKey) }
    }

    /// Restrict uploads to WiFi connections. Default: true.
    static var wifiOnly: Bool {
        get { (UserDefaults.standard.object(forKey: wifiOnlyKey) as? Bool) ?? true }
        set { UserDefaults.standard.set(newValue, forKey: wifiOnlyKey) }
    }

    // MARK: - Status

    static var lastSyncDate: Date? {
        get { UserDefaults.standard.object(forKey: lastSyncDateKey) as? Date }
        set { UserDefaults.standard.set(newValue, forKey: lastSyncDateKey) }
    }

    // MARK: - Album mapping

    /// Server album ID used when albumMode is .all. nil = no album association.
    static var allPhotosTargetAlbumId: Int? {
        get {
            let v = UserDefaults.standard.integer(forKey: allPhotosAlbumIdKey)
            return v == 0 ? nil : v
        }
        set {
            if let v = newValue {
                UserDefaults.standard.set(v, forKey: allPhotosAlbumIdKey)
            } else {
                UserDefaults.standard.removeObject(forKey: allPhotosAlbumIdKey)
            }
        }
    }

    /// Maps iOS album localIdentifier → server album ID (used when albumMode is .selected).
    static var albumMappings: [String: Int] {
        get { UserDefaults.standard.dictionary(forKey: albumMappingsKey) as? [String: Int] ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: albumMappingsKey) }
    }

    // MARK: - Uploaded asset tracking

    /// Load the set of already-uploaded local asset identifiers.
    static func loadUploadedIds() -> Set<String> {
        Set(UserDefaults.standard.stringArray(forKey: uploadedIdsKey) ?? [])
    }

    /// Persist the given set of uploaded identifiers.
    static func saveUploadedIds(_ ids: Set<String>) {
        UserDefaults.standard.set(Array(ids), forKey: uploadedIdsKey)
    }

    /// Clears the uploaded-asset history and resets the last sync date so all
    /// photos are considered unseen on the next sync run.
    static func resetUploadHistory() {
        UserDefaults.standard.removeObject(forKey: uploadedIdsKey)
        UserDefaults.standard.removeObject(forKey: lastSyncDateKey)
        UserDefaults.standard.removeObject(forKey: syncedFavoriteIdsKey)
    }

    /// Number of photos successfully uploaded so far.
    static var uploadedCount: Int {
        (UserDefaults.standard.stringArray(forKey: uploadedIdsKey) ?? []).count
    }

    // MARK: - Favourite sync tracking
    //
    // Tracks which local asset identifiers have been confirmed as "favourite"
    // on the server. On each sync run the service compares the current iOS
    // favourite state against this set and sends a PATCH /photos/:id/curation
    // request for any photo whose state has changed (marked or un-marked).

    static var syncedFavoriteLocalIds: Set<String> {
        get { Set(UserDefaults.standard.stringArray(forKey: syncedFavoriteIdsKey) ?? []) }
        set { UserDefaults.standard.set(Array(newValue), forKey: syncedFavoriteIdsKey) }
    }

    // MARK: - Server photo → local asset reverse mapping
    //
    // Maps server photo ID (String) → iOS localIdentifier (String).
    // Built during upload; used by the download service to avoid round-tripping
    // photos that already exist locally on this device.
    // This mapping is intentionally NOT cleared by resetUploadHistory() because
    // it reflects structural knowledge ("this server photo IS this local asset")
    // that remains valid regardless of upload-history resets.

    static func loadServerPhotoMap() -> [String: String] {
        UserDefaults.standard.dictionary(forKey: serverPhotoMapKey) as? [String: String] ?? [:]
    }

    static func saveServerPhotoMap(_ map: [String: String]) {
        UserDefaults.standard.set(map, forKey: serverPhotoMapKey)
    }

    static func recordUploadedPhoto(serverPhotoId: Int, localIdentifier: String) {
        var map = loadServerPhotoMap()
        map[String(serverPhotoId)] = localIdentifier
        saveServerPhotoMap(map)
    }
}
