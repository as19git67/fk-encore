import Foundation

/// Where a photo's pixels should be fetched from, and under which cache key.
///
/// The original file used to be the answer everywhere: every grid, the
/// fullscreen viewer, the slideshow and the collage renderer all loaded
/// `/photos/file/<filename>`. Only the crop editor rendered a photo through
/// the user's saved recipe, so a saved crop was visible inside the sheet that
/// made it and nowhere else — which reads, correctly, as „the crop was not
/// applied" (#1085 §1a).
///
/// A photo the user has edited is therefore fetched from
/// `GET /photos/:id/render?v=user` instead. Which photos those are comes from
/// `TransformedPhotosIndex`, one call for the whole app, the way the web's
/// `useTransformedPhotosIndex` does it.
///
/// Everything here is pure, so the routing and — more importantly — the cache
/// key are testable without a server.
enum PhotoImageSource: Sendable {

    /// One resolved fetch.
    struct Request: Equatable, Sendable {
        let path: String
        let query: [String: String]
        /// The key this image is cached under. It must change whenever the
        /// pixels change, or a photo cached before its recipe existed keeps
        /// winning forever — `ImageCache` is disk-backed and survives launches.
        let cacheKey: String
    }

    /// The fetch for one photo.
    ///
    /// - Parameters:
    ///   - photoId: nil for a photo known only by filename (an album cover
    ///     row, say). Such a photo is always fetched as the original: without
    ///     an id there is nothing to render.
    ///   - hasRecipe: whether this user has saved a recipe for it.
    ///   - revision: bumped locally on every edit this app makes, so the new
    ///     rendering is not read back out of the cache. It travels as a query
    ///     parameter too, because the render route answers
    ///     `Cache-Control: immutable` and `URLSession` would otherwise hold
    ///     the old bytes under the unchanged URL.
    static func request(
        photoId: Int?,
        filename: String,
        userId: Int?,
        hasRecipe: Bool,
        revision: Int = 0,
        width: Int? = nil
    ) -> Request {
        guard hasRecipe, let photoId, let userId else {
            var query: [String: String] = [:]
            if let width { query["w"] = String(width) }
            return Request(
                path: "/photos/file/\(filename)",
                query: query,
                // Unchanged from before recipes were rendered, so the caches
                // already on people's phones stay valid.
                cacheKey: width.map { "photo-\(filename)-w\($0)" } ?? "photo-\(filename)"
            )
        }

        var query = PhotoTransforms.renderQuery(.user(id: userId), width: width)
        query["rev"] = String(revision)
        return Request(
            path: PhotoTransforms.renderPath(photoId: photoId),
            query: query,
            cacheKey: cacheKey(
                filename: filename, userId: userId, revision: revision, width: width
            )
        )
    }

    static func cacheKey(
        filename: String,
        userId: Int,
        revision: Int,
        width: Int?
    ) -> String {
        let size = width.map { "-w\($0)" } ?? ""
        return "photo-\(filename)-u\(userId)-r\(revision)\(size)"
    }
}
