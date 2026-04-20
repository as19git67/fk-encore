import SwiftUI

struct AlbumDetailView: View {
    let albumId: Int
    @State private var album: Album?
    @State private var userRole: String = ""
    @State private var photos: [PhotoWithCuration] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var showShareSheet = false
    @State private var showUpload = false
    @State private var showDeleteConfirm = false
    @State private var isDeleting = false
    @State private var selectedPhoto: PhotoWithCuration?
    @State private var isFullscreenPresented = false
    @State private var filterSort = FilterSortViewModel()
    @Environment(\.dismiss) private var dismiss

    private var displayedPhotos: [PhotoWithCuration] {
        let filtered = filterSort.appliedFilter.isEmpty
            ? photos
            : photos.filter { matchesFilter($0, filterSort.appliedFilter) }
        return filterSort.appliedSort.isDefault
            ? filtered
            : filtered.sorted(by: filterSort.appliedSort.comparator)
    }

    private let columns = [
        GridItem(.adaptive(minimum: 100, maximum: 150), spacing: 2)
    ]

    var body: some View {
        ScrollView {
            if isLoading {
                ProgressView()
                    .padding(.top, 100)
            } else if photos.isEmpty {
                ContentUnavailableView {
                    Label("Leer", systemImage: "photo.on.rectangle.angled")
                } description: {
                    Text("Dieses Album enthält noch keine Fotos.")
                }
            } else {
                LazyVGrid(columns: columns, spacing: 2) {
                    ForEach(displayedPhotos) { photo in
                        Button {
                            selectedPhoto = photo
                            isFullscreenPresented = true
                        } label: {
                            PhotoThumbnailView(filename: photo.filename, autoCrop: photo.auto_crop)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 2)
            }
        }
        .navigationTitle(album?.name ?? "Album")
        .navigationBarTitleDisplayMode(.large)
        .navigationDestination(isPresented: $isFullscreenPresented) {
            if let photo = selectedPhoto {
                PhotoFullscreenView(photo: photo)
            }
        }
        .sheet(isPresented: $filterSort.isMenuPresented) {
            FilterSortMenuView(viewModel: filterSort, available: [.favorite, .mediaType, .hasGps, .dateRange])
                .presentationDetents([.medium, .large])
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                FilterSortButton(viewModel: filterSort)
            }
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showUpload = true
                } label: {
                    Image(systemName: "photo.badge.plus")
                }
            }
            if userRole == "owner" || userRole == "admin" {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showShareSheet = true
                    } label: {
                        Image(systemName: "person.crop.circle.badge.plus")
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button(role: .destructive) {
                        showDeleteConfirm = true
                    } label: {
                        Image(systemName: "trash")
                    }
                }
            }
        }
        .confirmationDialog("Album löschen?", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
            Button("Löschen", role: .destructive) {
                Task { await deleteAlbum() }
            }
            Button("Abbrechen", role: .cancel) {}
        } message: {
            Text("Das Album wird unwiderruflich gelöscht. Die Fotos bleiben erhalten.")
        }
        .sheet(isPresented: $showUpload) {
            PhotoUploadView(albumId: albumId) {
                Task { await loadAlbum() }
            }
        }
        .sheet(isPresented: $showShareSheet) {
            AlbumShareView(albumId: albumId)
        }
        .task {
            await loadAlbum()
        }
    }

    private func deleteAlbum() async {
        isDeleting = true
        do {
            let _: DeleteResponse = try await APIClient.shared.delete("/albums/\(albumId)")
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
        isDeleting = false
    }

    private func loadAlbum() async {
        isLoading = true
        do {
            struct AlbumResponse: Codable {
                let id: Int
                let name: String
                let description: String?
                let photos: [PhotoWithCuration]
                let role: String?
            }
            let response: AlbumResponse = try await APIClient.shared.get("/albums/\(albumId)")
            userRole = response.role ?? ""
            album = Album(
                id: response.id,
                user_id: 0,
                name: response.name,
                description: response.description,
                cover_photo_id: nil,
                cover_filename: nil,
                display_mode: "grid",
                newest_photo_at: nil,
                oldest_photo_at: nil,
                photo_count: response.photos.count,
                is_shared: false,
                created_at: "",
                updated_at: ""
            )
            photos = response.photos
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}
