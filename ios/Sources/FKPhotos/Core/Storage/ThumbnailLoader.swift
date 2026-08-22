import Foundation
import SwiftUI

/// Async image loader with caching for photo thumbnails.
@Observable
final class ThumbnailLoader: @unchecked Sendable {
    private(set) var image: UIImage?
    private(set) var isLoading = false
    private(set) var hasError = false

    private let filename: String

    init(filename: String) {
        self.filename = filename
    }

    @MainActor
    func load() async {
        guard !isLoading, image == nil else { return }

        let cacheKey = "photo-\(filename)"

        if let cached = await ImageCache.shared.image(forKey: cacheKey) {
            image = cached
            return
        }

        isLoading = true
        defer { isLoading = false }

        do {
            let data = try await APIClient.shared.downloadData("/photos/file/\(filename)")
            guard let loadedImage = UIImage(data: data) else {
                hasError = true
                return
            }
            image = loadedImage
            await ImageCache.shared.store(loadedImage, forKey: cacheKey)
        } catch {
            hasError = true
        }
    }
}
