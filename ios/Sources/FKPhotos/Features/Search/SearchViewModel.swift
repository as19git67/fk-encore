import Foundation

@Observable
final class SearchViewModel {
    var query = ""
    var results: [PhotoWithCuration] = []
    var isSearching = false
    var errorMessage: String?
    var hasSearched = false

    @MainActor
    func search() async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        isSearching = true
        errorMessage = nil
        hasSearched = true

        do {
            struct SearchBody: Encodable { let query: String }
            let response: ListPhotosResponse = try await APIClient.shared.post(
                "/photos/search",
                body: SearchBody(query: trimmed)
            )
            results = response.photos
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
}
