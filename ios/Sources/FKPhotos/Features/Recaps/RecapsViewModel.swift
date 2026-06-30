import SwiftUI

/// Loads the user's recaps for the list screen and resolves cover thumbnails.
/// Read-only: recaps are generated server-side; this only fetches and tracks
/// "seen" state so the list badge can drop without a full reload.
@Observable @MainActor
final class RecapsViewModel {
    private(set) var recaps: [RecapSummary] = []
    /// Resolved cover filenames keyed by `cover_photo_id`, filled lazily after
    /// the recap list loads (the list endpoint returns only photo ids).
    private(set) var coverFilenames: [Int: String] = [:]
    private(set) var isLoading = false
    var errorMessage: String?

    /// Recaps marked seen during this session (optimistic, so the "Neu" badge
    /// drops immediately without re-fetching the list).
    private var seenIds: Set<Int> = []

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response: ListRecapsResponse = try await APIClient.shared.get("/recaps")
            recaps = response.recaps
            await loadCovers(for: response.recaps)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func loadCovers(for recaps: [RecapSummary]) async {
        let ids = Array(Set(recaps.compactMap { $0.cover_photo_id }))
        guard !ids.isEmpty else { return }
        let query = ["ids": ids.map(String.init).joined(separator: ",")]
        // A cover-resolution failure must not break the list, so swallow errors.
        guard let response: RecapPhotoDetailsResponse =
            try? await APIClient.shared.get("/photos/details", query: query) else { return }
        coverFilenames = Dictionary(response.photos.map { ($0.id, $0.filename) }, uniquingKeysWith: { first, _ in first })
    }

    func coverFilename(for recap: RecapSummary) -> String? {
        recap.cover_photo_id.flatMap { coverFilenames[$0] }
    }

    func isUnseen(_ recap: RecapSummary) -> Bool {
        recap.seen_at == nil && !seenIds.contains(recap.id)
    }

    /// Marks a recap seen locally and notifies the server (fire-and-forget).
    func markSeen(_ id: Int) async {
        seenIds.insert(id)
        struct EmptyBody: Encodable {}
        struct SeenResponse: Decodable { let seen: Bool }
        _ = try? await APIClient.shared.post("/recaps/\(id)/seen", body: EmptyBody()) as SeenResponse
    }
}
