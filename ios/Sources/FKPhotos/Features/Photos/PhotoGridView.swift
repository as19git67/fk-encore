import SwiftUI

struct PhotoGridView: View {
    @State private var viewModel = PhotosViewModel()

    private let columns = [
        GridItem(.adaptive(minimum: 100, maximum: 150), spacing: 2)
    ]

    var body: some View {
        ScrollView {
            if viewModel.isLoading && viewModel.photos.isEmpty {
                ProgressView("Fotos laden...")
                    .padding(.top, 100)
            } else if let error = viewModel.errorMessage, viewModel.photos.isEmpty {
                ContentUnavailableView {
                    Label("Fehler", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Erneut versuchen") {
                        Task { await viewModel.loadPhotos() }
                    }
                }
            } else if viewModel.photos.isEmpty {
                ContentUnavailableView {
                    Label("Keine Fotos", systemImage: "photo.on.rectangle.angled")
                } description: {
                    Text("Lade Fotos hoch, um loszulegen.")
                }
            } else {
                LazyVGrid(columns: columns, spacing: 2) {
                    ForEach(viewModel.photos) { photo in
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
        .navigationTitle("Fotos")
        .navigationDestination(for: Int.self) { photoId in
            PhotoDetailView(photoId: photoId)
        }
        .refreshable {
            await viewModel.loadPhotos()
        }
        .task {
            await viewModel.loadPhotos()
        }
    }
}

struct PhotoThumbnailView: View {
    @State private var loader: ThumbnailLoader

    init(filename: String) {
        _loader = State(initialValue: ThumbnailLoader(filename: filename))
    }

    var body: some View {
        Group {
            if let image = loader.image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Rectangle()
                    .fill(.quaternary)
                    .overlay {
                        if loader.isLoading {
                            ProgressView()
                        } else if loader.hasError {
                            Image(systemName: "exclamationmark.triangle")
                                .foregroundStyle(.red.opacity(0.6))
                        } else {
                            Image(systemName: "photo")
                                .foregroundStyle(.secondary)
                        }
                    }
            }
        }
        .task {
            await loader.load()
        }
    }
}
