import Foundation
import SwiftUI

/// Async image loader with caching for photo thumbnails.
///
/// A photo the signed-in user has a saved recipe for is loaded through
/// `/photos/:id/render?v=user` rather than through the original file, so a
/// crop is visible in every grid rather than only inside the editor that made
/// it (#1085 §1a). `PhotoImageSource` decides which, and — just as important —
/// under which cache key: `ImageCache` is disk-backed, so a stale key would
/// keep serving the un-cropped original for as long as the phone kept it.
///
/// `photoId` is optional because a few call sites know a photo only by
/// filename (album and recap covers, a face row). Those keep loading the
/// original, which is what they did before.
@Observable
final class ThumbnailLoader: @unchecked Sendable {
    private(set) var image: UIImage?
    private(set) var isLoading = false
    private(set) var hasError = false
    /// True once the loaded image came from the user's recipe rather than from
    /// the original file. Callers use it to drop framing they applied to the
    /// original — an AI focal point means nothing on a photo the user has
    /// framed themselves.
    private(set) var isRecipeRendered = false

    private let filename: String
    private let photoId: Int?

    init(filename: String, photoId: Int? = nil) {
        self.filename = filename
        self.photoId = photoId
    }

    @MainActor
    func load() async {
        guard !isLoading, image == nil else { return }

        // The index has to be in before the route can be chosen: asking too
        // early answers „no recipe" for every photo and caches the original
        // under the original's key, which is exactly the stale-tile trap.
        if photoId != nil {
            await TransformedPhotosIndex.shared.load()
        }
        let source = TransformedPhotosIndex.shared.request(
            photoId: photoId,
            filename: filename
        )
        isRecipeRendered = TransformedPhotosIndex.shared.hasRecipe(photoId)

        if let cached = await ImageCache.shared.image(forKey: source.cacheKey) {
            image = cached
            return
        }

        isLoading = true
        defer { isLoading = false }

        do {
            let data = try await APIClient.shared.downloadData(
                source.path,
                query: source.query.isEmpty ? nil : source.query
            )
            guard let loadedImage = UIImage(data: data) else {
                hasError = true
                return
            }
            image = loadedImage
            await ImageCache.shared.store(loadedImage, forKey: source.cacheKey)
        } catch {
            hasError = true
        }
    }
}
