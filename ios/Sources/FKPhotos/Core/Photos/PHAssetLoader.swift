import Photos

/// Loads the original image bytes for a PHAsset using PHAssetResourceManager,
/// preserving all EXIF/XMP/IPTC metadata without transcoding.
enum PHAssetLoader {

    struct ImageData {
        let data: Data
        let mimeType: String
    }

    enum LoadError: LocalizedError {
        case noResource
        case noData
        var errorDescription: String? {
            switch self {
            case .noResource: return "Keine Bildressource gefunden"
            case .noData:     return "Keine Bilddaten verfügbar"
            }
        }
    }

    /// Loads the full-size original image data for the given asset.
    /// Falls back to `.photo` if no `.fullSizePhoto` resource exists.
    static func loadOriginal(for asset: PHAsset) async throws -> ImageData {
        let resources = PHAssetResource.assetResources(for: asset)
        guard let resource = resources.first(where: { $0.type == .fullSizePhoto })
                          ?? resources.first(where: { $0.type == .photo }) else {
            throw LoadError.noResource
        }

        let mimeType = mimeType(for: resource.uniformTypeIdentifier)
        var buffer = Data()

        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true  // download from iCloud if needed

        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            PHAssetResourceManager.default().requestData(
                for: resource,
                options: options,
                dataReceivedHandler: { chunk in buffer.append(chunk) },
                completionHandler: { error in
                    if let error { cont.resume(throwing: error) }
                    else if buffer.isEmpty { cont.resume(throwing: LoadError.noData) }
                    else { cont.resume() }
                }
            )
        }

        return ImageData(data: buffer, mimeType: mimeType)
    }

    // MARK: - Private

    private static func mimeType(for uti: String) -> String {
        let lower = uti.lowercased()
        if lower.contains("heic") || lower.contains("heif") { return "image/heic" }
        if lower.contains("png")                            { return "image/png" }
        if lower.contains("tiff")                           { return "image/tiff" }
        if lower.contains("webp")                           { return "image/webp" }
        return "image/jpeg"
    }
}
