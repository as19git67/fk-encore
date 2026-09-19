import Foundation
import SwiftUI

/// Two-tier image cache: NSCache (memory) + disk cache in Caches directory.
///
/// The disk half had no upper bound: every thumbnail, once loaded, stayed
/// there forever. On a library the size the app is built for that grows
/// without limit — nothing ever called `clearDisk()`. `enforceDiskCacheLimit()`
/// is the fix: a size cap, oldest-looked-at-first eviction, run occasionally
/// rather than on every write (`store()` is the hot path — every thumbnail a
/// grid scrolls past that wasn't cached yet — and a full-folder stat pass has
/// no business there).
actor ImageCache {
    static let shared = ImageCache()

    /// Soft cap for the disk cache's total size. Thumbnails only, so this
    /// covers a very large library with room to spare; the number matters far
    /// less than the fact that there is one.
    static let defaultDiskCacheLimitBytes = 500 * 1024 * 1024 // 500 MB
    /// How often `runMaintenanceIfNeeded()` actually does anything. The cap
    /// is soft by design — a few hundred extra MB between runs is fine — so
    /// there is no reason to stat the whole folder on every launch.
    static let defaultMaintenanceInterval: TimeInterval = 24 * 60 * 60 // 1 day

    private let memoryCache = NSCache<NSString, CacheEntry>()
    private let diskCacheURL: URL
    private let maxDiskBytes: Int
    private let maintenanceInterval: TimeInterval
    private let defaults: UserDefaults
    private let lastMaintenanceKey = "imageCache.lastMaintenance"

    /// - Parameters:
    ///   - directory: Where the disk cache lives. Overridable so tests can
    ///     point it at a throwaway folder instead of the app's real Caches
    ///     directory.
    ///   - maxDiskBytes: The size cap `enforceDiskCacheLimit()` enforces.
    ///   - maintenanceInterval: The rate limit for `runMaintenanceIfNeeded()`.
    ///   - defaults: Where the last-run timestamp is kept. Overridable for
    ///     the same reason as `directory`.
    init(
        directory: URL? = nil,
        maxDiskBytes: Int = ImageCache.defaultDiskCacheLimitBytes,
        maintenanceInterval: TimeInterval = ImageCache.defaultMaintenanceInterval,
        defaults: UserDefaults = .standard
    ) {
        if let directory {
            diskCacheURL = directory
        } else {
            let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            diskCacheURL = caches.appendingPathComponent("FKPhotosImageCache", isDirectory: true)
        }
        try? FileManager.default.createDirectory(at: diskCacheURL, withIntermediateDirectories: true)
        self.maxDiskBytes = maxDiskBytes
        self.maintenanceInterval = maintenanceInterval
        self.defaults = defaults

        memoryCache.countLimit = 200
        memoryCache.totalCostLimit = 100 * 1024 * 1024 // 100 MB
    }

    func image(forKey key: String) -> UIImage? {
        let nsKey = key as NSString

        // Check memory cache
        if let entry = memoryCache.object(forKey: nsKey) {
            return entry.image
        }

        // Check disk cache
        let fileURL = diskCacheURL.appendingPathComponent(key.safeFilename)
        guard let data = try? Data(contentsOf: fileURL),
              let image = UIImage(data: data) else {
            return nil
        }

        // Promote to memory cache
        let cost = data.count
        memoryCache.setObject(CacheEntry(image: image), forKey: nsKey, cost: cost)

        // A disk hit means this thumbnail is still wanted; back-date its
        // eviction order by bumping the modification date `enforceDiskCacheLimit()`
        // sorts on. Memory-cache hits (the common case while actively
        // scrolling) never reach here, so this stays cheap.
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: fileURL.path)

        return image
    }

    func store(_ image: UIImage, forKey key: String) {
        let nsKey = key as NSString

        guard let data = image.jpegData(compressionQuality: 0.85) else { return }

        // Memory cache
        memoryCache.setObject(CacheEntry(image: image), forKey: nsKey, cost: data.count)

        // Disk cache
        let fileURL = diskCacheURL.appendingPathComponent(key.safeFilename)
        try? data.write(to: fileURL)
    }

    func clearMemory() {
        memoryCache.removeAllObjects()
    }

    func clearDisk() {
        try? FileManager.default.removeItem(at: diskCacheURL)
        try? FileManager.default.createDirectory(at: diskCacheURL, withIntermediateDirectories: true)
    }

    // MARK: - Disk cache maintenance

    /// Runs `enforceDiskCacheLimit()`, but only if it has not already run
    /// within `maintenanceInterval` — the one call sites should actually use.
    /// Cheap to call on every launch: the common case is "ran recently",
    /// which costs one `UserDefaults` read and nothing else.
    func runMaintenanceIfNeeded(now: Date = Date()) {
        if let last = defaults.object(forKey: lastMaintenanceKey) as? Date,
           now.timeIntervalSince(last) < maintenanceInterval {
            return
        }
        enforceDiskCacheLimit()
        defaults.set(now, forKey: lastMaintenanceKey)
    }

    /// Deletes disk-cache files, oldest-looked-at first, until the folder is
    /// back under `maxDiskBytes`. "Oldest" is the file's modification date,
    /// which `store()` sets on write and `image(forKey:)` refreshes on every
    /// disk hit — so this is an LRU eviction, not a FIFO one: a thumbnail
    /// still being looked at survives, one nobody has scrolled past in
    /// months does not.
    func enforceDiskCacheLimit() {
        let fm = FileManager.default
        guard let urls = try? fm.contentsOfDirectory(
            at: diskCacheURL,
            includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey]
        ) else { return }

        var entries: [(url: URL, date: Date, size: Int)] = []
        var total = 0
        for url in urls {
            guard let values = try? url.resourceValues(
                forKeys: [.contentModificationDateKey, .fileSizeKey]
            ), let size = values.fileSize else { continue }
            entries.append((url, values.contentModificationDate ?? .distantPast, size))
            total += size
        }
        guard total > maxDiskBytes else { return }

        for entry in entries.sorted(by: { $0.date < $1.date }) {
            guard total > maxDiskBytes else { break }
            do {
                try fm.removeItem(at: entry.url)
                total -= entry.size
            } catch {
                continue
            }
        }
    }
}

// NSCache requires reference-type values
private final class CacheEntry: @unchecked Sendable {
    let image: UIImage
    init(image: UIImage) { self.image = image }
}

private extension String {
    var safeFilename: String {
        replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: ":", with: "_")
            .replacingOccurrences(of: "?", with: "_")
    }
}
