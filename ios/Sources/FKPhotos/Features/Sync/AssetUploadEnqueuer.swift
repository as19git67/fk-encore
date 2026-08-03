import Foundation
import Photos

/// Single shared implementation of "grab a PHAsset and turn it into an
/// `UploadQueueItem`" used by **both** upload paths (issue #591):
///
///  * Part A — the manual album upload (`PhotoUploadView`), and
///  * Part B — the automatic library/folder sync (`PhotoSyncService`).
///
/// Centralising it guarantees the two paths derive the *same* `image_data_hash`
/// and `full_hash` for the same photo, so server-side dedup (and the
/// device-asset-id "replace on edit" branch) behaves identically no matter how
/// the photo was enqueued. Before this existed, `PhotoUploadView` hashed the
/// PHImageManager-rendered JPEG bytes while the sync path hashed the decoded
/// pixels of the original resource — the two never matched and dedup silently
/// failed across the two paths.
enum AssetUploadEnqueuer {
    /// The resource whose bytes we hash and upload. The **edited** render
    /// (`.fullSizePhoto`) is preferred so crops and adjustments reach the
    /// server at full quality (issue #591); we fall back to the untouched
    /// original (`.photo`) for assets that have never been edited.
    ///
    /// This MUST be the single source of truth for resource selection so the
    /// hash (`PhotoHasher`), the uploaded bytes (`PhotoSyncService.loadAssetData`)
    /// and any background-job resource all refer to identical pixels.
    static func bestResource(for asset: PHAsset) -> PHAssetResource? {
        let resources = PHAssetResource.assetResources(for: asset)
        return resources.first(where: { $0.type == .fullSizePhoto })
            ?? resources.first(where: { $0.type == .photo })
    }

    /// The asset's *original* filename (e.g. "IMG_1234.HEIC"). Read from the
    /// `.photo` resource on purpose: `bestResource` prefers the **edited**
    /// `.fullSizePhoto` render for the uploaded pixels, but that render is named
    /// generically "FullSizeRender.heic" by Photos. Taking the name from there
    /// made every edited album upload land as "FullSizeRender.heic" (issue #591).
    /// The real per-asset name lives on the original `.photo` resource, so we read
    /// it from there regardless of which resource supplies the bytes. Falls back
    /// to any resource's name, then nil so the caller can synthesise one.
    static func originalFilename(for asset: PHAsset) -> String? {
        let resources = PHAssetResource.assetResources(for: asset)
        return resources.first(where: { $0.type == .photo })?.originalFilename
            ?? resources.first?.originalFilename
    }

    /// Builds a fully-populated `UploadQueueItem` for *asset*, computing the
    /// hash/metadata via the shared `PhotoHasher` pipeline (caption, favourite,
    /// capture date) and carrying `PHAsset.location` for the GPS-fallback
    /// headers. Returns nil when the asset's bytes can't be hashed (e.g. iCloud
    /// data is unavailable) so the caller can retry it later.
    ///
    /// - Parameters:
    ///   - precomputedHash: reuse a `PhotoHashResult` already computed by the
    ///     caller (the sync pipeline hashes in batches) to avoid re-reading the
    ///     asset bytes twice.
    ///   - filenameHint: original filename pre-fetched off the main queue by the
    ///     sync pipeline; falls back to the resource's `originalFilename`.
    static func makeQueueItem(
        for asset: PHAsset,
        precomputedHash: PhotoHashResult? = nil,
        filenameHint: String? = nil,
        targetAlbumIds: [Int] = [],
        sourceIosAlbumId: String? = nil
    ) async -> UploadQueueItem? {
        let hashResult: PhotoHashResult
        if let precomputedHash {
            hashResult = precomputedHash
        } else if let computed = await PhotoHasher.shared.hashes(for: asset) {
            hashResult = computed
        } else {
            return nil
        }

        let resource = bestResource(for: asset)
        let mimeType = resource.map { PhotoSyncService.mimeType(for: $0.uniformTypeIdentifier) } ?? "image/jpeg"
        let baseName = filenameHint
            ?? originalFilename(for: asset)
            ?? "photo_\(asset.localIdentifier.prefix(8)).jpg"
        let filename = filenameMatchingMime(baseName, mimeType: mimeType)
        let caption = PhotoHasher.shared.captionFromAsset(asset) ?? ""

        return UploadQueueItem(
            assetLocalIdentifier: asset.localIdentifier,
            filename: filename,
            mimeType: mimeType,
            imageDataHash: hashResult.imageDataHash,
            fullHash: hashResult.fullHash,
            caption: caption,
            isFavorite: asset.isFavorite,
            capturedAtString: hashResult.capturedAtString,
            targetAlbumIds: targetAlbumIds,
            sourceIosAlbumId: sourceIosAlbumId,
            latitude: asset.location?.coordinate.latitude,
            longitude: asset.location?.coordinate.longitude
        )
    }

    /// Detects the image format from the data's magic bytes. Used on the
    /// PhotosPicker fallback path, where iOS hands us raw bytes without a
    /// `PHAsset` (and thus without a `uniformTypeIdentifier` to map). That path
    /// used to declare everything as `image/jpeg`, so a PNG was stored under a
    /// `.jpg` name with a mismatching Content-Type.
    ///
    /// Only the formats the server accepts are recognised; anything else falls
    /// back to JPEG, which is what the old behaviour assumed unconditionally.
    static func mimeType(forImageData data: Data) -> String {
        func matches(_ signature: [UInt8], at offset: Int = 0) -> Bool {
            guard data.count >= offset + signature.count else { return false }
            let start = data.index(data.startIndex, offsetBy: offset)
            return !zip(data[start...], signature).contains { $0 != $1 }
        }

        if matches([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) { return "image/png" }
        if matches([0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
        if matches([0x47, 0x49, 0x46, 0x38]) { return "image/gif" }
        // RIFF....WEBP
        if matches([0x52, 0x49, 0x46, 0x46]), matches([0x57, 0x45, 0x42, 0x50], at: 8) { return "image/webp" }
        // ISO-BMFF brand box: "ftyp" at offset 4, HEIC/HEIF brand right after.
        if matches([0x66, 0x74, 0x79, 0x70], at: 4) {
            for brand in [[0x68, 0x65, 0x69, 0x63], [0x68, 0x65, 0x69, 0x78],
                          [0x68, 0x65, 0x76, 0x63], [0x6D, 0x69, 0x66, 0x31]] as [[UInt8]]
            where matches(brand, at: 8) {
                return "image/heic"
            }
        }
        if matches([0x49, 0x49, 0x2A, 0x00]) || matches([0x4D, 0x4D, 0x00, 0x2A]) { return "image/tiff" }
        return "image/jpeg"
    }

    /// Replaces the filename's extension with one matching *mimeType* when the
    /// two disagree. Equivalent extensions (heic ↔ heif, jpg ↔ jpeg) are treated
    /// as matching so user-recognisable names aren't churned needlessly.
    static func filenameMatchingMime(_ filename: String, mimeType: String) -> String {
        let expectedExt: String
        switch mimeType.lowercased() {
        case "image/heic", "image/heif": expectedExt = "heic"
        case "image/png":                expectedExt = "png"
        case "image/tiff":               expectedExt = "tiff"
        case "image/gif":                expectedExt = "gif"
        case "image/webp":               expectedExt = "webp"
        default:                         expectedExt = "jpg"
        }
        let ns = filename as NSString
        let currentExt = ns.pathExtension.lowercased()
        if currentExt == expectedExt { return filename }
        let heicLike: Set<String> = ["heic", "heif"]
        if expectedExt == "heic" && heicLike.contains(currentExt) { return filename }
        let jpegLike: Set<String> = ["jpg", "jpeg"]
        if expectedExt == "jpg" && jpegLike.contains(currentExt) { return filename }
        let stem = ns.deletingPathExtension
        return stem.isEmpty ? "photo.\(expectedExt)" : "\(stem).\(expectedExt)"
    }
}
