import Foundation
import SwiftUI

@Observable
final class PhotosViewModel {
    var photos: [PhotoWithCuration] = []
    var isLoading = false
    var errorMessage: String?

    @MainActor
    func loadPhotos(filter: PhotoFilter = .empty, sort: PhotoSortState = .default) async {
        isLoading = true
        errorMessage = nil

        do {
            let response: ListPhotosResponse = try await APIClient.shared.get(
                "/photos",
                query: filter.queryParams()
            )
            let raw = Array(response.photos.reversed())
            photos = sort.isDefault ? raw : raw.sorted(by: sort.comparator)
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    @MainActor
    func setCuration(photoId: Int, status: CurationStatus, filter: PhotoFilter = .empty, sort: PhotoSortState = .default) async {
        do {
            let body = CurationBody(id: photoId, status: status)
            let _: PhotoWithCuration = try await APIClient.shared.put("/photos/curation", body: body)
            if photos.contains(where: { $0.id == photoId }) {
                await loadPhotos(filter: filter, sort: sort)
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
