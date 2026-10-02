import Foundation
import SwiftUI

@Observable
final class PhotosViewModel {
    var photos: [PhotoWithCuration] = []
    var isLoading = false
    var errorMessage: String?
    /// The format groups by member photo id
    /// (.claude/plans/orientierungs-varianten.md): which photos have another
    /// side, and which photos that is. Loaded alongside the photos from
    /// `GET /photos/groups`; empty when that request fails, which only costs
    /// the badges.
    var variantsByPhotoId: [Int: OrientationVariants] = [:]

    /// The photos on the other side of `photoId`'s format group, best first.
    func counterpartIds(of photoId: Int) -> [Int] {
        variantsByPhotoId[photoId]?.counterpartIds(of: photoId) ?? []
    }

    /// - Parameter variantMode: which side of every format group to ask for.
    ///   `.all` is what the server does without the parameter.
    @MainActor
    func loadPhotos(
        filter: PhotoFilter = .empty,
        sort: PhotoSortState = .default,
        variantMode: VariantMode = .all
    ) async {
        isLoading = true
        errorMessage = nil

        var query = filter.queryParams()
        if variantMode != .all { query["variantMode"] = variantMode.rawValue }
        async let groupsResponse = Self.loadGroups()

        do {
            let response: ListPhotosResponse = try await APIClient.shared.get(
                "/photos",
                query: query
            )
            let raw = Array(response.photos.reversed())
            photos = sort.isDefault ? raw : raw.sorted(by: sort.comparator)
        } catch {
            errorMessage = error.localizedDescription
        }

        if let groups = await groupsResponse {
            variantsByPhotoId = OrientationVariantRules.byPhotoId(groups: groups.groups)
        }

        isLoading = false
    }

    /// The group list, or nil when it cannot be had — the grid works without
    /// it, only the format badges go missing.
    private static func loadGroups() async -> AlbumGroupReview.ListResponse? {
        do {
            let response: AlbumGroupReview.ListResponse = try await APIClient.shared.get("/photos/groups")
            return response
        } catch {
            return nil
        }
    }

    @MainActor
    func setCuration(
        photoId: Int,
        status: CurationStatus,
        filter: PhotoFilter = .empty,
        sort: PhotoSortState = .default,
        variantMode: VariantMode = .all
    ) async {
        do {
            let body = CurationBody(id: photoId, status: status)
            let _: PhotoWithCuration = try await APIClient.shared.put("/photos/curation", body: body)
            if photos.contains(where: { $0.id == photoId }) {
                await loadPhotos(filter: filter, sort: sort, variantMode: variantMode)
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
