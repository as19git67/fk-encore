import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import Photos

struct PhotoHashResult {
    /// SHA-256 of the decoded image pixels (stable across caption/favorite/date edits).
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

        let fullHash = Self.fullHash(
            imageDataHash: imageDataHash,
            caption: caption,
            isFavorite: isFavorite,
            capturedAtString: capturedAtString
        )
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

    /// Reads original PHAssetResource bytes and computes SHA-256 of the *decoded
    /// pixel data*, independent of any EXIF/IPTC/XMP metadata in the file.
    ///
    /// Hashing the file bytes is unstable across caption edits because the
    /// Photos app re-embeds the caption when it hands a shared photo to the
    /// share extension; re-wrapping via CGImageDestination does not help either
    /// (it merges metadata rather than dropping it, and can fail for HEIC).
    /// Decoding to pixels and hashing those is metadata-proof — only an actual
    /// pixel change moves the hash.
    ///
    /// This MUST stay byte-identical to `ShareHasher.imageDataHash` in the share
    /// extension (F4milShare/ShareViewController.swift): a photo first
    /// uploaded via the share extension and later re-sent by the library
    /// auto-sync only deduplicates server-side when both paths derive the same
    /// `image_data_hash`.
    private func computeImageDataHash(for asset: PHAsset) async -> String? {
        // Prefer the *edited* render (.fullSizePhoto) so crops/adjustments move
        // the pixel hash and get re-uploaded; fall back to the original (.photo)
        // for never-edited assets. Shared with the upload-bytes selection so the
        // hash always describes exactly the bytes we send (issue #591).
        guard let resource = AssetUploadEnqueuer.bestResource(for: asset)
        else { return nil }

        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true

        return await withCheckedContinuation { continuation in
            var combined = Data()
            PHAssetResourceManager.default().requestData(for: resource, options: options) { chunk in
                combined.append(chunk)
            } completionHandler: { error in
                guard error == nil else { continuation.resume(returning: nil); return }
                // Hash the decoded pixels, not the file bytes — metadata in the
                // container (caption/EXIF/XMP) must not move the hash. Falls
                // back to the raw bytes only when the image cannot be decoded.
                let hashInput = Self.decodedPixelData(combined) ?? combined
                let hash = SHA256.hash(data: hashInput).map { String(format: "%02x", $0) }.joined()
                continuation.resume(returning: hash)
            }
        }
    }

    /// Decodes the image to a bounded-size bitmap and returns its raw pixel
    /// bytes in a fixed RGBA layout — deterministic for identical pixels and
    /// free of any container metadata. Returns nil when the data cannot be
    /// decoded.
    ///
    /// The image is decoded at a bounded size (1024px) so a large photo cannot
    /// exhaust memory. This MUST stay byte-identical to
    /// `ShareHasher.decodedPixelData` in the share extension so both upload
    /// paths produce the same `image_data_hash`.
    private static func decodedPixelData(_ data: Data) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: 1024,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return nil
        }
        let width = image.width
        let height = image.height
        guard width > 0, height > 0 else { return nil }
        let bytesPerRow = width * 4
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let pixels = context.data else { return nil }
        return Data(bytes: pixels, count: height * bytesPerRow)
    }

    /// Pixel-stable image hash for raw file bytes when no `PHAsset` is
    /// available — the PhotosPicker fallback path (Part A) where the system
    /// hands us only `Data`. Hashes the decoded pixels (metadata-proof, matching
    /// `computeImageDataHash`), falling back to the raw bytes when undecodable.
    nonisolated static func imageDataHash(from data: Data) -> String {
        let input = decodedPixelData(data) ?? data
        return SHA256.hash(data: input).map { String(format: "%02x", $0) }.joined()
    }

    private static func formatCapturedAt(_ date: Date?, timezone: TimeZone) -> String {
        guard let date else { return "" }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = timezone
        return f.string(from: date)
    }

    /// Composite identity hash: the pixel hash plus every syncable metadata
    /// field (caption, favourite, capture date). Must stay byte-identical to
    /// the formula the Share Extension and the server contract rely on, so it
    /// lives in one place and is reused wherever a full hash is (re)computed.
    nonisolated static func fullHash(
        imageDataHash: String,
        caption: String,
        isFavorite: Bool,
        capturedAtString: String
    ) -> String {
        let composite = imageDataHash + "\n" + caption + "\n" + (isFavorite ? "1" : "0") + "\n" + capturedAtString
        return SHA256.hash(data: Data(composite.utf8)).map { String(format: "%02x", $0) }.joined()
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
