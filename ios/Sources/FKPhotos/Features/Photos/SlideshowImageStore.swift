import SwiftUI
import UIKit

/// Downloads and holds the full-size images a slideshow is about to show.
///
/// Shared by the recap player and the photo slideshow: both need the same
/// "fetch a few ahead, remember what failed, never fetch twice" behaviour, and
/// both need the decoded size afterwards — the orientation that decides pairing
/// is only known once an image exists.
///
/// Results also land in the shared `ImageCache`, so replaying a show, or
/// opening one of its photos in the viewer, costs nothing.
@Observable
final class SlideshowImageStore: @unchecked Sendable {
    private(set) var images: [Int: UIImage] = [:]
    /// Indices whose download failed. They are drawn as an error glyph and
    /// treated as settled, so one broken photo cannot stall a show forever.
    private(set) var failed: Set<Int> = []

    private var loading: Set<Int> = []
    private var items: [Item] = []

    /// One photo in the sequence. The id is what lets a photo the user has
    /// edited be shown through their recipe rather than as the original
    /// (#1085 §1a) — a slideshow that ignored the crop would be the one place
    /// the edit disappeared again.
    struct Item: Sendable {
        let id: Int?
        let filename: String

        init(id: Int?, filename: String) {
            self.id = id
            self.filename = filename
        }

        init(_ photo: PhotoWithCuration) {
            self.init(id: photo.id, filename: photo.filename)
        }
    }

    /// Point the store at a new photo sequence, discarding everything held for
    /// the old one.
    func reset(photos: [Item]) {
        self.items = photos
        images = [:]
        failed = []
        loading = []
    }

    /// Whether a load attempt for `index` has finished, successfully or not.
    func isSettled(_ index: Int) -> Bool {
        images[index] != nil || failed.contains(index)
    }

    /// Orientation per photo, `nil` where the image has not arrived yet —
    /// exactly the input `SlideshowPlanner.extend` expects.
    var orientations: [SlideOrientation?] {
        items.indices.map { index in
            if let image = images[index] { return SlideOrientation(size: image.size) }
            // A photo that will never load has no shape to pair on. Reporting
            // it as square keeps planning moving past it instead of waiting
            // for a size that is not coming.
            if failed.contains(index) { return .square }
            return nil
        }
    }

    /// Start downloads for `index` and the next `ahead` photos. Each photo is
    /// fetched at most once.
    func prefetch(around index: Int, ahead: Int) {
        for i in index...(index + ahead) where i >= 0 && i < items.count {
            guard images[i] == nil, !failed.contains(i), !loading.contains(i) else { continue }
            loading.insert(i)
            Task { await load(i) }
        }
    }

    @MainActor
    private func load(_ index: Int) async {
        defer { loading.remove(index) }
        let item = items[index]
        if item.id != nil {
            await TransformedPhotosIndex.shared.load()
        }
        let source = TransformedPhotosIndex.shared.request(
            photoId: item.id,
            filename: item.filename
        )

        if let cached = await ImageCache.shared.image(forKey: source.cacheKey) {
            images[index] = cached
            return
        }
        do {
            let data = try await APIClient.shared.downloadData(
                source.path,
                query: source.query.isEmpty ? nil : source.query
            )
            guard let image = UIImage(data: data) else {
                failed.insert(index)
                return
            }
            await ImageCache.shared.store(image, forKey: source.cacheKey)
            images[index] = image
        } catch {
            failed.insert(index)
        }
    }
}
