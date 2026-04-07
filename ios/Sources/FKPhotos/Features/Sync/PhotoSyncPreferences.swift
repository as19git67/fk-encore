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

    /// Number of photos successfully uploaded so far.
    static var uploadedCount: Int {
        (UserDefaults.standard.stringArray(forKey: uploadedIdsKey) ?? []).count
    }
}
