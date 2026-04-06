import Foundation
import SwiftUI

/// Async image loader with caching for photo thumbnails.
@Observable
final class ThumbnailLoader: @unchecked Sendable {
    private(set) var image: UIImage?
    private(set) var isLoading = false

    private let photoId: Int
    private let isThumbnail: Bool

    init(photoId: Int, isThumbnail: Bool = true) {
        self.photoId = photoId
        self.isThumbnail = isThumbnail
    }

    @MainActor
    func load() async {
        guard !isLoading else { return }

        let cacheKey = "photo-\(photoId)-\(isThumbnail ? "thumb" : "full")"

        // Check cache first
        if let cached = await ImageCache.shared.image(forKey: cacheKey) {
            image = cached
            return
        }

        isLoading = true
        defer { isLoading = false }

        do {
            var query: [String: String] = [:]
            if isThumbnail {
                query["thumbnail"] = "true"
            }

            let data = try await APIClient.shared.downloadData(
                "/photos/\(photoId)/file",
                query: query.isEmpty ? nil : query
            )

            guard let loadedImage = UIImage(data: data) else { return }
            image = loadedImage
            await ImageCache.shared.store(loadedImage, forKey: cacheKey)
        } catch {
            // Silently fail — UI shows placeholder
        }
    }
}
