import Foundation
import SwiftUI

/// Two-tier image cache: NSCache (memory) + disk cache in Caches directory.
actor ImageCache {
    static let shared = ImageCache()

    private let memoryCache = NSCache<NSString, CacheEntry>()
    private let diskCacheURL: URL

    init() {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        diskCacheURL = caches.appendingPathComponent("FKPhotosImageCache", isDirectory: true)
        try? FileManager.default.createDirectory(at: diskCacheURL, withIntermediateDirectories: true)

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
