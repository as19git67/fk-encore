import Foundation

@Observable
final class AlbumsViewModel {
    var albums: [Album] = []
    var isLoading = false
    var errorMessage: String?

    @MainActor
    func loadAlbums() async {
        isLoading = true
        errorMessage = nil

        do {
            let response: ListAlbumsResponse = try await APIClient.shared.get("/albums")
            albums = response.albums
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    @MainActor
    func createAlbum(name: String, description: String?) async -> Bool {
        struct Body: Codable {
            let name: String
            let description: String?
        }
        struct CreateResponse: Codable {
            let id: Int
            let name: String
        }

        do {
            let _: CreateResponse = try await APIClient.shared.post("/albums", body: Body(name: name, description: description))
            await loadAlbums()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    @MainActor
    func deleteAlbum(id: Int) async {
        do {
            let _: DeleteResponse = try await APIClient.shared.delete("/albums/\(id)")
            albums.removeAll { $0.id == id }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
