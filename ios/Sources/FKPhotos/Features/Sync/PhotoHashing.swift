import CryptoKit
import Foundation
import Photos

struct PhotoHashResult {
    /// SHA-256 of the original PHAssetResource bytes (stable across caption/favorite/date edits).
    let imageDataHash: String
    /// SHA-256 over imageDataHash + caption + isFavorite + capturedAtString (changes on any sync-relevant edit).
    let fullHash: String
    /// ISO-8601 capture date with local timezone offset, e.g. "2026-05-20T15:00:00+02:00". Used as X-Captured-At header.
    let capturedAtString: String
}

/// Computes and caches the two photo hashes required by the server upload contract.
///
/// Uses the original PHAssetResource (.photo type) bytes for hashing — Photos.app stores
/// caption/favorite/date outside the resource file, so the hash is stable across metadata
/// edits and only changes when the actual pixels change.
///
/// Cache is keyed by (localIdentifier, modificationDate). iOS bumps modificationDate
/// on any edit (including metadata-only), so a stale entry is always detected.
actor PhotoHasher {
    static let shared = PhotoHasher()

    private struct CacheEntry {
        let modificationDate: Date
        let result: PhotoHashResult
    }

    // In-memory cache (rebuilt from UserDefaults on first use via PhotoSyncPreferences).
    private var cache: [String: CacheEntry] = [:]
    private var cacheLoaded = false

    private init() {}

    // MARK: - Public API

    func hashes(for asset: PHAsset) async -> PhotoHashResult? {
        ensureCacheLoaded()
        let localId = asset.localIdentifier
        let modDate = asset.modificationDate ?? .distantPast

        if let cached = cache[localId], cached.modificationDate == modDate {
            return cached.result
        }

        guard let imageDataHash = await computeImageDataHash(for: asset) else { return nil }

        // Always use the device's current timezone so that the capturedAtString is
        // consistent regardless of EXIF data. Downloaded photos from older uploads
        // can have "+00:00" baked into their EXIF (because the original upload used UTC),
        // which caused the server to display the wrong time for CEST users.
        let capturedAtString = Self.formatCapturedAt(asset.creationDate, timezone: TimeZone.current)
        let caption = captionFromAsset(asset) ?? ""
        let isFavorite = asset.isFavorite

        let composite = imageDataHash + "\n" + caption + "\n" + (isFavorite ? "1" : "0") + "\n" + capturedAtString
        let fullHash = sha256Hex(Data(composite.utf8))
        let result = PhotoHashResult(imageDataHash: imageDataHash, fullHash: fullHash, capturedAtString: capturedAtString)

        cache[localId] = CacheEntry(modificationDate: modDate, result: result)
        PhotoSyncPreferences.saveHashCacheEntry(
            localId: localId,
            entry: .init(modDateISO: ISO8601DateFormatter().string(from: modDate),
                         imageDataHash: imageDataHash,
                         fullHash: fullHash,
                         capturedAtString: capturedAtString)
        )
        return result
    }

    // MARK: - Private

    private func ensureCacheLoaded() {
        guard !cacheLoaded else { return }
        cacheLoaded = true
        let stored = PhotoSyncPreferences.loadHashCache()
        let isoParser = ISO8601DateFormatter()
        for (localId, entry) in stored {
            guard let modDate = isoParser.date(from: entry.modDateISO) else { continue }
            cache[localId] = CacheEntry(
                modificationDate: modDate,
                result: PhotoHashResult(
                    imageDataHash: entry.imageDataHash,
                    fullHash: entry.fullHash,
                    capturedAtString: entry.capturedAtString
                )
            )
        }
    }

    /// Reads original PHAssetResource bytes and computes SHA-256 of the raw file data.
    private func computeImageDataHash(for asset: PHAsset) async -> String? {
        // Prefer the original resource; fall back to fullSizePhoto for assets that only have an edited version.
        guard let resource = PHAssetResource.assetResources(for: asset)
            .first(where: { $0.type == .photo })
            ?? PHAssetResource.assetResources(for: asset).first(where: { $0.type == .fullSizePhoto })
        else { return nil }

        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true

        return await withCheckedContinuation { continuation in
            var chunks: [Data] = []
            PHAssetResourceManager.default().requestData(for: resource, options: options) { chunk in
                chunks.append(chunk)
            } completionHandler: { error in
                guard error == nil else { continuation.resume(returning: nil); return }
                let combined = chunks.reduce(Data(), +)
                let hash = SHA256.hash(data: combined).map { String(format: "%02x", $0) }.joined()
                continuation.resume(returning: hash)
            }
        }
    }

    private static func formatCapturedAt(_ date: Date?, timezone: TimeZone) -> String {
        guard let date else { return "" }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = timezone
        return f.string(from: date)
    }

    nonisolated private func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Reads the Photos.app caption via private KVC. Returns nil when no caption is set.
    nonisolated func captionFromAsset(_ asset: PHAsset) -> String? {
        guard (asset as AnyObject).responds(to: NSSelectorFromString("descriptionProperties")),
              let descProps = (asset as NSObject).value(forKey: "descriptionProperties") as? NSObject,
              (descProps as AnyObject).responds(to: NSSelectorFromString("assetDescription")),
              let caption = descProps.value(forKey: "assetDescription") as? String,
              !caption.isEmpty else { return nil }
        return caption
    }
}
