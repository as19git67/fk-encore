import Foundation
import SwiftUI

@Observable
final class PhotosViewModel {
    var photos: [PhotoWithCuration] = []
    var isLoading = false
    var errorMessage: String?

    @MainActor
    func loadPhotos() async {
        isLoading = true
        errorMessage = nil

        do {
            let response: ListPhotosResponse = try await APIClient.shared.get("/photos")
            photos = response.photos.reversed()
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    @MainActor
    func setCuration(photoId: Int, status: CurationStatus) async {
        do {
            let body = CurationBody(id: photoId, status: status)
            let _: PhotoWithCuration = try await APIClient.shared.put("/photos/curation", body: body)

            if let index = photos.firstIndex(where: { $0.id == photoId }) {
                // Reload to get updated state
                await loadPhotos()
                _ = index // suppress unused warning
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct CurationBody: Codable {
    let id: Int
    let status: CurationStatus
}
