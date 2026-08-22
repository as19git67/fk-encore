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
    private var filenames: [String] = []

    /// Point the store at a new photo sequence, discarding everything held for
    /// the old one.
    func reset(filenames: [String]) {
        self.filenames = filenames
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
        filenames.indices.map { index in
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
        for i in index...(index + ahead) where i >= 0 && i < filenames.count {
            guard images[i] == nil, !failed.contains(i), !loading.contains(i) else { continue }
            loading.insert(i)
            Task { await load(i) }
        }
    }

    @MainActor
    private func load(_ index: Int) async {
        defer { loading.remove(index) }
        let filename = filenames[index]
        let key = "photo-\(filename)"

        if let cached = await ImageCache.shared.image(forKey: key) {
            images[index] = cached
            return
        }
        do {
            let data = try await APIClient.shared.downloadData("/photos/file/\(filename)")
            guard let image = UIImage(data: data) else {
                failed.insert(index)
                return
            }
            await ImageCache.shared.store(image, forKey: key)
            images[index] = image
        } catch {
            failed.insert(index)
        }
    }
}
