import Foundation

@Observable
final class PhotoMetadataViewModel {
    struct NamedFace: Identifiable {
        let id: Int
        let personName: String
    }

    let photo: PhotoWithCuration
    var curationStatus: CurationStatus
    private(set) var takenAt: String?
    private(set) var description: String?
    private(set) var keywords: [String] = []

    var namedFaces: [NamedFace] = []
    var facesLoadFailed = false
    var sortedAlbums: [Album] = []
    var photoAlbumIds: Set<Int> = []
    var pendingAdds: Set<Int> = []
    var pendingRemoves: Set<Int> = []
    var isLoadingFaces = false
    var isLoadingAlbums = false
    var isSavingAlbums = false
    private var hasLoaded = false

    private struct PhotoAlbumsResult: Codable {
        let photoId: Int
        let albumIds: [Int]
    }
    private struct PhotoAlbumsResponse: Codable {
        let results: [PhotoAlbumsResult]
    }
    private struct BatchBody: Codable {
        let albumIds: [Int]
        let photoIds: [Int]
        let action: String
    }
    private struct BoolResponse: Codable { let success: Bool }
    private struct DateResponse: Codable { let success: Bool; let taken_at: String }

    init(photo: PhotoWithCuration) {
        self.photo = photo
        self.curationStatus = photo.curation_status
        self.takenAt = photo.taken_at
        self.description = photo.description
        self.keywords = photo.keywords ?? []
    }

    @MainActor
    func loadAll() async {
        guard !hasLoaded else { return }
        hasLoaded = true
        async let facesTask: Void = loadFaces()
        async let albumsTask: Void = loadAlbums()
        async let detailsTask: Void = loadDetails()
        _ = await (facesTask, albumsTask, detailsTask)
    }

    @MainActor
    private func loadFaces() async {
        isLoadingFaces = true
        facesLoadFailed = false
        defer { isLoadingFaces = false }
        do {
            let facesResponse: ListFacesResponse = try await APIClient.shared.get("/photos/\(photo.id)/faces")
            let personsResponse: ListPersonsResponse = try await APIClient.shared.get("/persons")
            let personsMap: [Int: String] = Dictionary(
                uniqueKeysWithValues: personsResponse.persons.map { ($0.id, $0.name) }
            )
            namedFaces = facesResponse.faces
                .filter { !$0.ignored && $0.person_id != nil }
                .compactMap { face -> NamedFace? in
                    guard let pid = face.person_id,
                          let name = personsMap[pid],
                          !name.trimmingCharacters(in: .whitespaces).isEmpty,
                          name != "Unbenannt" else { return nil }
                    return NamedFace(id: face.id, personName: name)
                }
        } catch {
            facesLoadFailed = true
        }
    }

    @MainActor
    private func loadAlbums() async {
        isLoadingAlbums = true
        defer { isLoadingAlbums = false }
        do {
            async let albumsReq: ListAlbumsResponse = APIClient.shared.get("/albums")
            async let photoAlbumsReq: PhotoAlbumsResponse = APIClient.shared.get(
                "/photos/albums", query: ["ids": "\(photo.id)"]
            )
            let (albumsResponse, photoAlbumsResponse) = try await (albumsReq, photoAlbumsReq)
            if let result = photoAlbumsResponse.results.first(where: { $0.photoId == photo.id }) {
                photoAlbumIds = Set(result.albumIds)
            }
            // Selected albums first, then unselected – both groups sorted alphabetically
            let all = albumsResponse.albums
            let selected = all.filter { photoAlbumIds.contains($0.id) }.sorted { $0.name < $1.name }
            let unselected = all.filter { !photoAlbumIds.contains($0.id) }.sorted { $0.name < $1.name }
            sortedAlbums = selected + unselected
        } catch {
            // silently ignore
        }
    }

    func albumCheckState(for albumId: Int) -> Bool {
        if pendingAdds.contains(albumId) { return true }
        if pendingRemoves.contains(albumId) { return false }
        return photoAlbumIds.contains(albumId)
    }

    func toggleAlbum(_ albumId: Int) {
        let current = albumCheckState(for: albumId)
        if current {
            pendingAdds.remove(albumId)
            if photoAlbumIds.contains(albumId) {
                pendingRemoves.insert(albumId)
            }
        } else {
            pendingRemoves.remove(albumId)
            if !photoAlbumIds.contains(albumId) {
                pendingAdds.insert(albumId)
            }
        }
    }

    var hasPendingAlbumChanges: Bool {
        !pendingAdds.isEmpty || !pendingRemoves.isEmpty
    }

    @MainActor
    func saveAlbumChanges() async {
        isSavingAlbums = true
        defer { isSavingAlbums = false }
        do {
            if !pendingAdds.isEmpty {
                let _: BoolResponse = try await APIClient.shared.post(
                    "/albums/photos/batch",
                    body: BatchBody(albumIds: Array(pendingAdds), photoIds: [photo.id], action: "add")
                )
            }
            if !pendingRemoves.isEmpty {
                let _: BoolResponse = try await APIClient.shared.post(
                    "/albums/photos/batch",
                    body: BatchBody(albumIds: Array(pendingRemoves), photoIds: [photo.id], action: "remove")
                )
            }
            for id in pendingAdds { photoAlbumIds.insert(id) }
            for id in pendingRemoves { photoAlbumIds.remove(id) }
            pendingAdds.removeAll()
            pendingRemoves.removeAll()
        } catch {
            // silently ignore
        }
    }

    @MainActor
    private func loadDetails() async {
        // Skip if already populated from the photo model
        guard photo.description == nil && photo.keywords == nil else { return }
        struct DetailEntry: Codable { let id: Int; let description: String?; let keywords: [String]? }
        struct DetailsResponse: Codable { let photos: [DetailEntry] }
        do {
            let response: DetailsResponse = try await APIClient.shared.get(
                "/photos/details", query: ["ids": "\(photo.id)"]
            )
            if let entry = response.photos.first(where: { $0.id == photo.id }) {
                description = entry.description
                keywords = entry.keywords ?? []
            }
        } catch {}
    }

    @MainActor
    func updateDescription(_ text: String?) async {
        struct Body: Codable { let description: String? }
        struct Response: Codable { let success: Bool; let description: String? }
        do {
            let result: Response = try await APIClient.shared.patch(
                "/photos/\(photo.id)/description",
                body: Body(description: text?.isEmpty == true ? nil : text)
            )
            description = result.description
        } catch {}
    }

    @MainActor
    func updatePhotoDate(_ date: Date) async {
        struct Body: Codable { let taken_at: String }
        // Wall-clock string in the device's local time (issue #433). The
        // server stores `taken_at` as `timestamp without time zone`, so
        // sending a UTC ISO would shift the value by the user's offset.
        let fmt = DateFormatter()
        fmt.calendar = Calendar(identifier: .iso8601)
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        let dateStr = fmt.string(from: date)
        do {
            let result: DateResponse = try await APIClient.shared.patch(
                "/photos/\(photo.id)/date",
                body: Body(taken_at: dateStr)
            )
            takenAt = result.taken_at
        } catch {}
    }

    @MainActor
    func setCuration(_ status: CurationStatus) async {
        struct Body: Codable { let status: CurationStatus }
        struct Response: Codable { let success: Bool }
        do {
            let _: Response = try await APIClient.shared.patch(
                "/photos/\(photo.id)/curation",
                body: Body(status: status)
            )
            curationStatus = status
        } catch {}
    }
}
