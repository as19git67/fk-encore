import Foundation

@Observable
final class SearchViewModel {
    var query = ""
    var results: [PhotoWithCuration] = []
    var isSearching = false
    var errorMessage: String?
    var hasSearched = false

    /// How the server read the last query — rendered as the "Verstanden als:"
    /// chip row. Nil until a search has run, and cleared on every new one so a
    /// stale reading never sits under a fresh result set.
    var parsed: NaturalSearch.ParsedQuery?

    /// The query `parsed` belongs to. The semantic chip only shows when the
    /// parse differs from what was asked, and "what was asked" has to be the
    /// text that was actually sent — `query` keeps changing as the user types
    /// the next search, which would otherwise make the chip flicker under a
    /// result set it has nothing to do with.
    private var parsedQuery = ""

    /// The chips for `parsed`, empty when there is nothing to report.
    var chips: [NaturalSearch.Chip] {
        NaturalSearch.chips(for: parsed, query: parsedQuery)
    }

    /// Semantic search with the location and date parts of the query applied as
    /// filters rather than searched for as words. Same endpoint the web's
    /// `NaturalSearchBar` uses, so „Kirchen in München von 2004 bis 2017"
    /// means the same thing on both.
    @MainActor
    func search() async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        isSearching = true
        errorMessage = nil
        hasSearched = true
        parsed = nil
        parsedQuery = trimmed

        do {
            let response: NaturalSearch.Response = try await APIClient.shared.post(
                "/photos/search/natural",
                body: NaturalSearch.Request(query: trimmed)
            )
            parsed = response.parsed
            results = try await photos(forRankedIds: response.results.map(\.photoId))
        } catch {
            errorMessage = error.localizedDescription
        }

        isSearching = false
    }

    @MainActor
    func searchByLocation(lat: Double, lng: Double, radius: Double = 10) async {
        isSearching = true
        errorMessage = nil
        hasSearched = true
        parsed = nil
        parsedQuery = ""

        do {
            let response: ListPhotosResponse = try await APIClient.shared.get(
                "/photos/search/location",
                query: [
                    "lat": "\(lat)",
                    "lng": "\(lng)",
                    "radius": "\(radius)"
                ]
            )
            results = response.photos
        } catch {
            errorMessage = error.localizedDescription
        }

        isSearching = false
    }

    func clear() {
        query = ""
        results = []
        parsed = nil
        parsedQuery = ""
        errorMessage = nil
        hasSearched = false
    }

    /// Resolve hit ids into full photo rows, keeping the search's own ranking.
    ///
    /// The natural endpoint returns scored ids, not photos; the batch endpoint
    /// returns rows in its own order. Ids it does not answer for (deleted, or
    /// no longer visible) simply drop out.
    private func photos(forRankedIds ids: [Int]) async throws -> [PhotoWithCuration] {
        guard !ids.isEmpty else { return [] }
        let response: PhotoDetailsBatchResponse = try await APIClient.shared.get(
            "/photos/details",
            query: ["ids": ids.map(String.init).joined(separator: ",")]
        )
        let byId = Dictionary(
            response.photos.map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        return ids.compactMap { byId[$0] }
    }
}
