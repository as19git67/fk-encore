import SwiftUI

struct AlbumDetailView: View {
    let albumId: Int
    @State private var album: Album?
    @State private var photos: [PhotoWithCuration] = []
    @State private var isLoading = true
    @State private var errorMessage: String?

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
                    ForEach(photos) { photo in
                        NavigationLink(value: photo.id) {
                            PhotoThumbnailView(filename: photo.filename)
                                .aspectRatio(1, contentMode: .fill)
                                .clipped()
                        }
                    }
                }
                .padding(.horizontal, 2)
            }
        }
        .navigationTitle(album?.name ?? "Album")
        .navigationBarTitleDisplayMode(.large)
        .navigationDestination(for: Int.self) { photoId in
            PhotoDetailView(photoId: photoId)
        }
        .task {
            await loadAlbum()
        }
    }

    private func loadAlbum() async {
        isLoading = true
        do {
            struct AlbumResponse: Codable {
                let id: Int
                let name: String
                let description: String?
                let photos: [PhotoWithCuration]
            }
            let response: AlbumResponse = try await APIClient.shared.get("/albums/\(albumId)")
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
