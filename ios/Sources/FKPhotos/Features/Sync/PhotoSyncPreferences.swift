import Foundation

/// Sync mode for a linked iOS album (issue #812).
enum PhotoSyncMode: String, Sendable {
    /// Upload new photos only; never remove anything from the server album.
    case copy
    /// Upload new photos and remove server-album entries whose source asset has
    /// left the iOS album. Non-destructive to the photo itself — only the album
    /// membership is removed.
    case sync
    /// Two-way: behaves like `sync` for the upload direction and additionally
    /// pulls new server photos onto the device and mirrors server-side removals
    /// (via PhotoDownloadService) for the same album pair.
    case bisync
}

/// Namespace for all sync-related UserDefaults keys and typed accessors.
/// Thread-safe through UserDefaults's own serialization.
struct PhotoSyncPreferences {
    private init() {}

    static let taskIdentifier = "dev.fk-encore.F4milPhotos.photoSync"

    /// Sentinel id stored in `selectedAlbumIds` when the user picked the
    /// synthetic "Gesamte Mediathek" entry. `PhotoSyncService` treats it as
    /// "enumerate every image asset, not bound to any PHAssetCollection".
    static let allLibrarySentinel = "__all_photos__"

    // MARK: - Keys

    private static let enabledKey          = "sync.enabled"
    private static let selectedAlbumsKey   = "sync.selectedAlbumIds"
    private static let wifiOnlyKey         = "sync.wifiOnly"
    private static let lastSyncDateKey     = "sync.lastSyncDate"
    private static let albumMappingsKey    = "sync.albumMappings"
    private static let albumSyncDatesKey  = "sync.albumSyncDates"
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

    static var selectedAlbumIds: Set<String> {
        get { Set(UserDefaults.standard.stringArray(forKey: selectedAlbumsKey) ?? []) }
        set { UserDefaults.standard.set(Array(newValue), forKey: selectedAlbumsKey) }
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

    /// Maps iOS album localIdentifier → server album ID.
    static var albumMappings: [String: Int] {
        get { UserDefaults.standard.dictionary(forKey: albumMappingsKey) as? [String: Int] ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: albumMappingsKey) }
    }

    // MARK: - Per-album sync mode
    //
    // One-way sync behaviour for a linked iOS album:
    //  - copy: upload new photos only; server-side removals never happen.
    //  - sync: upload new photos AND remove server-album entries whose source
    //          asset has left the iOS album (issue #812, "Sync" mode). Only the
    //          album membership is removed — the photo itself stays on the server.
    // Stored as [iosAlbumId: rawValue]. Absent entry defaults to copy so existing
    // Etappe-2 links keep their non-destructive behaviour.

    private static let albumSyncModesKey = "sync.albumSyncModes"

    private static func loadAlbumSyncModes() -> [String: String] {
        UserDefaults.standard.dictionary(forKey: albumSyncModesKey) as? [String: String] ?? [:]
    }

    static func albumSyncMode(for albumId: String) -> PhotoSyncMode {
        loadAlbumSyncModes()[albumId].flatMap(PhotoSyncMode.init(rawValue:)) ?? .copy
    }

    static func setAlbumSyncMode(_ mode: PhotoSyncMode, for albumId: String) {
        var modes = loadAlbumSyncModes()
        modes[albumId] = mode.rawValue
        UserDefaults.standard.set(modes, forKey: albumSyncModesKey)
    }

    static func removeAlbumSyncMode(for albumId: String) {
        var modes = loadAlbumSyncModes()
        modes.removeValue(forKey: albumId)
        UserDefaults.standard.set(modes, forKey: albumSyncModesKey)
    }

    /// Server album IDs whose linked iOS album is in bisync mode (confirmed and
    /// mapped). Used by PhotoDownloadService to include these albums in the
    /// download pass — even when the global "Automatisch herunterladen" toggle
    /// is off — so the two-way sync's download half runs.
    static func bisyncServerAlbumIds() -> Set<Int> {
        let confirmed = confirmedMappingIds
        var result = Set<Int>()
        for (iosId, serverId) in albumMappings {
            guard confirmed.contains(iosId), albumSyncMode(for: iosId) == .bisync else { continue }
            result.insert(serverId)
        }
        return result
    }

    // MARK: - Confirmed album mappings
    //
    // Tracks which iOS albums have an explicit user decision for the server
    // album mapping (including "no album"). Albums not in this set are skipped
    // during auto-sync until the user makes a choice.

    private static let confirmedMappingsKey = "sync.confirmedMappings"

    static var confirmedMappingIds: Set<String> {
        get { Set(UserDefaults.standard.stringArray(forKey: confirmedMappingsKey) ?? []) }
        set { UserDefaults.standard.set(Array(newValue), forKey: confirmedMappingsKey) }
    }

    static func confirmMapping(for albumId: String) {
        var ids = confirmedMappingIds
        ids.insert(albumId)
        confirmedMappingIds = ids
    }

    static func unconfirmMapping(for albumId: String) {
        var ids = confirmedMappingIds
        ids.remove(albumId)
        confirmedMappingIds = ids
    }

    static func isMappingConfirmed(for albumId: String) -> Bool {
        confirmedMappingIds.contains(albumId)
    }

    // MARK: - Per-album sync dates

    private static func loadAlbumSyncDates() -> [String: Date] {
        UserDefaults.standard.dictionary(forKey: albumSyncDatesKey) as? [String: Date] ?? [:]
    }

    static func albumSyncDate(for albumId: String) -> Date? {
        loadAlbumSyncDates()[albumId]
    }

    static func setAlbumSyncDate(_ date: Date, for albumId: String) {
        var dates = loadAlbumSyncDates()
        dates[albumId] = date
        UserDefaults.standard.set(dates, forKey: albumSyncDatesKey)
    }

    static func resetAlbumSyncDate(for albumId: String) {
        var dates = loadAlbumSyncDates()
        dates.removeValue(forKey: albumId)
        UserDefaults.standard.set(dates, forKey: albumSyncDatesKey)
    }

    /// Monotonic-advance variant: only writes when `date` is strictly newer than
    /// the stored value. Used by the per-batch watermark so an out-of-order
    /// upload completion can't roll the watermark backwards and re-enumerate
    /// already-processed assets on the next run.
    static func advanceAlbumSyncDate(_ date: Date, for albumId: String) {
        var dates = loadAlbumSyncDates()
        if let current = dates[albumId], current >= date { return }
        dates[albumId] = date
        UserDefaults.standard.set(dates, forKey: albumSyncDatesKey)
    }

    // MARK: - One-time migrations

    private static let watermarkPoisonResetKey = "sync.migration.watermarkPoisonResetV1"

    /// One-time migration for installs that ran the old auto-upload, which
    /// advanced per-album watermarks to wall-clock `Date()` on every successful
    /// upload (and skipped past assets that failed to hash). The watermark logic
    /// is fixed now, but those installs still carry the poisoned dates, so the
    /// strict `creationDate >` enumeration would never re-surface the photos that
    /// were left behind.
    ///
    /// Clearing the watermarks once makes the next sync re-enumerate every album;
    /// already-uploaded photos are deduplicated server-side via
    /// `/photos/sync/check`, so only the genuinely missing ones are re-queued.
    /// Deliberately scoped to the watermarks only — the hash cache and
    /// synced-state survive, so the re-check stays cheap (no byte re-reads, the
    /// metadata-only fast path still applies). Guarded by a flag so it runs at
    /// most once. The `defaults` parameter exists for unit testing.
    static func runWatermarkPoisonMigrationIfNeeded(defaults: UserDefaults = .standard) {
        guard !defaults.bool(forKey: watermarkPoisonResetKey) else { return }
        defaults.removeObject(forKey: albumSyncDatesKey)
        defaults.set(true, forKey: watermarkPoisonResetKey)
    }

    // MARK: - Legacy smart-album purge (issue #812 follow-up)

    private static let smartAlbumPurgeKey = "sync.migration.smartAlbumPurgeV1"

    static var smartAlbumPurgeDone: Bool {
        get { UserDefaults.standard.bool(forKey: smartAlbumPurgeKey) }
        set { UserDefaults.standard.set(newValue, forKey: smartAlbumPurgeKey) }
    }

    /// Removes the given iOS album ids from every sync-config store: selection,
    /// server mapping, confirmation, per-album mode and watermark. Used by the
    /// legacy smart-album purge — a config could target a smart album via the
    /// old settings picker, which is neither shown nor manageable anymore and is
    /// unsafe to sync (dynamic membership). The `defaults` parameter exists for
    /// unit testing.
    static func purgeAlbumsFromConfig(_ ids: Set<String>, defaults: UserDefaults = .standard) {
        guard !ids.isEmpty else { return }

        let remaining = Set(defaults.stringArray(forKey: selectedAlbumsKey) ?? []).subtracting(ids)
        defaults.set(Array(remaining), forKey: selectedAlbumsKey)

        let confirmed = Set(defaults.stringArray(forKey: confirmedMappingsKey) ?? []).subtracting(ids)
        defaults.set(Array(confirmed), forKey: confirmedMappingsKey)

        if var mappings = defaults.dictionary(forKey: albumMappingsKey) as? [String: Int] {
            for id in ids { mappings.removeValue(forKey: id) }
            defaults.set(mappings, forKey: albumMappingsKey)
        }
        if var modes = defaults.dictionary(forKey: albumSyncModesKey) as? [String: String] {
            for id in ids { modes.removeValue(forKey: id) }
            defaults.set(modes, forKey: albumSyncModesKey)
        }
        if var dates = defaults.dictionary(forKey: albumSyncDatesKey) as? [String: Date] {
            for id in ids { dates.removeValue(forKey: id) }
            defaults.set(dates, forKey: albumSyncDatesKey)
        }
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
        UserDefaults.standard.removeObject(forKey: albumSyncDatesKey)
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
