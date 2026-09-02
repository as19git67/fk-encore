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

    /// Several photos at once, **in the order asked for**.
    ///
    /// The batch endpoint answers in its own order, and every caller so far
    /// has an order that matters — a search's ranking, a review group's
    /// AI-pick-first sequence — so the reordering belongs here rather than
    /// being written out again per call site. Ids the server does not answer
    /// for (deleted, or no longer visible) simply drop out.
    static func byIds(_ ids: [Int]) async throws -> [PhotoWithCuration] {
        guard !ids.isEmpty else { return [] }
        let response: PhotoDetailsBatchResponse = try await APIClient.shared.get(
            "/photos/details",
            query: ["ids": ids.map(String.init).joined(separator: ",")]
        )
        return ordered(response.photos, byIds: ids)
    }

    /// Put rows back into the order they were asked for, dropping the ids the
    /// server had no answer for. Pure, so the ordering is testable without a
    /// server.
    static func ordered(
        _ photos: [PhotoWithCuration],
        byIds ids: [Int]
    ) -> [PhotoWithCuration] {
        let byId = Dictionary(
            photos.map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        return ids.compactMap { byId[$0] }
    }
}

/// Response of `GET /photos/details`. The server normalizes the nullable
/// columns (`created_at`, `curation_status`) before sending, so the rows
/// decode straight into `PhotoWithCuration`.
struct PhotoDetailsBatchResponse: Codable, Sendable {
    let photos: [PhotoWithCuration]
}
