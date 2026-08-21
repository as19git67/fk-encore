import Foundation
import SwiftUI

/// Async image loader with caching for photo thumbnails.
@Observable
final class ThumbnailLoader: @unchecked Sendable {
    private(set) var image: UIImage?
    private(set) var isLoading = false
    private(set) var hasError = false

    /// Called on the main actor once a load attempt has settled, so an owner
    /// that is not observing this loader directly can react to it — the
    /// fullscreen slideshow waits for the current photo before advancing
    /// (`docs/photo-slideshow.md`). Not observed itself, so assigning it never
    /// invalidates a view.
    @ObservationIgnored var onLoadSettled: (() -> Void)?

    /// Whether a load attempt has finished, successfully or not.
    ///
    /// A *failed* load counts as settled on purpose: callers that wait for this
    /// (the slideshow) would otherwise stall forever on one broken image.
    var isSettled: Bool { image != nil || hasError }

    private let filename: String

    init(filename: String) {
        self.filename = filename
    }

    @MainActor
    func load() async {
        guard !isLoading, image == nil else {
            // Nothing to do — but a caller waiting on the settled signal still
            // needs it, or it would wait on a load that already happened. A
            // load still in flight reports through its own `defer` below.
            if isSettled { onLoadSettled?() }
            return
        }

        let cacheKey = "photo-\(filename)"

        if let cached = await ImageCache.shared.image(forKey: cacheKey) {
            image = cached
            onLoadSettled?()
            return
        }

        isLoading = true
        // Fires on every remaining exit — decoded, undecodable, or thrown — so
        // the settled signal cannot be skipped by an error path.
        defer {
            isLoading = false
            onLoadSettled?()
        }

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
