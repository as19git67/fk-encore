import Foundation

/// Fetching a single photo by id.
///
/// There is no `GET /photos/:id` on the server — only the batch endpoint
/// `GET /photos/details?ids=…`, which the recap player and the photo grids
/// already use. Callers that ask for one photo went to the missing route and
/// silently got a 404 back, so this wraps the batch endpoint instead of
/// letting every call site rediscover that.
enum PhotoFetch {

    /// The full photo behind an id — everything `PhotoFullscreenView` needs,
    /// where a feed item or a search hit carries only a filename and a few
    /// counters.
    ///
    /// Throws `APIError.httpError(404, …)` when the photo does not exist or
    /// the caller may not see it; the batch endpoint answers both with an
    /// empty list.
    static func byId(_ id: Int) async throws -> PhotoWithCuration {
        let response: PhotoDetailsBatchResponse = try await APIClient.shared.get(
            "/photos/details",
            query: ["ids": String(id)]
        )
        guard let photo = response.photos.first else {
            throw APIError.httpError(404, "Foto nicht gefunden")
        }
        return photo
    }
}

/// Response of `GET /photos/details`. The server normalizes the nullable
/// columns (`created_at`, `curation_status`) before sending, so the rows
/// decode straight into `PhotoWithCuration`.
struct PhotoDetailsBatchResponse: Codable, Sendable {
    let photos: [PhotoWithCuration]
}
