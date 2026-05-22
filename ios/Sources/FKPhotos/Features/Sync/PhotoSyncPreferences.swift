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
    private static let allPhotosAlbumIdKey = "sync.allPhotosAlbumId"
    private static let albumMappingsKey    = "sync.albumMappings"
    private static let serverPhotoMapKey   = "sync.serverPhotoMap"
    private static let excludeScreenshotsKey = "sync.excludeScreenshots"
    // Hash cache: [localIdentifier: HashCacheEntry] stored as JSON Data.
    // Replaces the old uploadedIds / syncedFavoriteIds / syncedTakenAt / syncedModDate / syncedUploadHash fields.
    // v2: switched capturedAtString from EXIF timezone to TimeZone.current (fixes UTC drift for downloaded photos)
    private static let hashCacheKey        = "sync.hashCache.v2"
    // Synced state: [localIdentifier: SyncedStateEntry] in App Group (shared with Share Extension).
    // Records the last imageDataHash + fullHash successfully synced to the server per asset,
    // so the client can detect pixel-only vs metadata-only changes.
    private static let syncedStateKey      = "sync.syncedState"

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

    // MARK: - Server photo ↔ local asset mapping
    //
    // Maps server photo ID (String) → iOS localIdentifier (String).
    // Built during upload; used by the download service to avoid round-tripping
    // photos that already exist locally on this device.
    // Not cleared by resetUploadHistory() because the mapping reflects structural
    // knowledge that remains valid regardless of upload-history resets.

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

    // MARK: - Upload count (derived from serverPhotoMap for UI display)

    /// Number of photos successfully uploaded and tracked in the server photo map.
    static var uploadedCount: Int {
        loadServerPhotoMap().count
    }

    // MARK: - Hash cache (replaces uploadedIds / syncedTakenAt / syncedModDate / syncedUploadHash)
    //
    // Stores per-asset (modificationDate, imageDataHash, fullHash, capturedAtString) so that
    // PhotoHasher can skip re-hashing assets whose modificationDate hasn't moved.

    struct HashCacheEntry: Codable {
        let modDateISO: String
        let imageDataHash: String
        let fullHash: String
        let capturedAtString: String
    }

    static func loadHashCache() -> [String: HashCacheEntry] {
        guard let data = UserDefaults.standard.data(forKey: hashCacheKey),
              let cache = try? JSONDecoder().decode([String: HashCacheEntry].self, from: data) else {
            return [:]
        }
        return cache
    }

    static func saveHashCacheEntry(localId: String, entry: HashCacheEntry) {
        var cache = loadHashCache()
        cache[localId] = entry
        if let data = try? JSONEncoder().encode(cache) {
            UserDefaults.standard.set(data, forKey: hashCacheKey)
        }
    }

    static func removeHashCacheEntry(localId: String) {
        var cache = loadHashCache()
        cache.removeValue(forKey: localId)
        if let data = try? JSONEncoder().encode(cache) {
            UserDefaults.standard.set(data, forKey: hashCacheKey)
        }
    }

    /// Resets upload history so all photos are re-evaluated on the next sync run.
    /// Does NOT clear the server photo map (structural mapping remains valid).
    static func resetUploadHistory() {
        UserDefaults.standard.removeObject(forKey: hashCacheKey)
        UserDefaults.standard.removeObject(forKey: lastSyncDateKey)
        SharedStorage.defaults.removeObject(forKey: syncedStateKey)
        // Remove legacy keys from previous sync implementation
        for key in ["sync.uploadedIds", "sync.syncedFavoriteIds",
                    "sync.syncedTakenAt", "sync.syncedModificationDate", "sync.syncedUploadHash"] {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    // MARK: - Synced state (App Group, shared with Share Extension)
    //
    // Tracks the last imageDataHash + fullHash that was successfully synced to the server
    // for each asset. Used to decide: metadata-only sync (pixels unchanged) vs full upload.

    struct SyncedStateEntry: Codable {
        let imageDataHash: String
        let fullHash: String
    }

    static func loadSyncedState() -> [String: SyncedStateEntry] {
        guard let data = SharedStorage.defaults.data(forKey: syncedStateKey),
              let cache = try? JSONDecoder().decode([String: SyncedStateEntry].self, from: data) else {
            return [:]
        }
        return cache
    }

    static func loadSyncedEntry(localId: String) -> SyncedStateEntry? {
        loadSyncedState()[localId]
    }

    static func saveSyncedStateEntry(localId: String, imageDataHash: String, fullHash: String) {
        var cache = loadSyncedState()
        cache[localId] = SyncedStateEntry(imageDataHash: imageDataHash, fullHash: fullHash)
        if let data = try? JSONEncoder().encode(cache) {
            SharedStorage.defaults.set(data, forKey: syncedStateKey)
        }
    }
}
