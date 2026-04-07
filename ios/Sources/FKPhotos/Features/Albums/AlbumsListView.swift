import SwiftUI

struct AlbumsListView: View {
    @State private var viewModel = AlbumsViewModel()
    @State private var showCreateSheet = false
    @State private var showErrorAlert = false
    @State private var newAlbumName = ""
    @State private var newAlbumDescription = ""

    var body: some View {
        List {
            if viewModel.isLoading && viewModel.albums.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .listRowSeparator(.hidden)
            } else if viewModel.albums.isEmpty {
                ContentUnavailableView {
                    Label("Keine Alben", systemImage: "rectangle.stack")
                } description: {
                    Text("Erstelle ein Album, um Fotos zu organisieren.")
                } actions: {
                    Button("Neues Album erstellen") {
                        showCreateSheet = true
                    }
                    .buttonStyle(.borderedProminent)
                }
                .listRowSeparator(.hidden)
            } else {
                ForEach(viewModel.albums) { album in
                    NavigationLink(value: album.id) {
                        AlbumRowView(album: album)
                    }
                }
                .onDelete { indexSet in
                    Task {
                        for index in indexSet {
                            await viewModel.deleteAlbum(id: viewModel.albums[index].id)
                        }
                    }
                }
            }
        }
        .navigationTitle("Alben")
        .navigationDestination(for: Int.self) { albumId in
            AlbumDetailView(albumId: albumId)
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showCreateSheet = true
                } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .refreshable {
            await viewModel.loadAlbums()
        }
        .task {
            await viewModel.loadAlbums()
        }
        .alert("Neues Album", isPresented: $showCreateSheet) {
            TextField("Name", text: $newAlbumName)
            TextField("Beschreibung (optional)", text: $newAlbumDescription)
            Button("Erstellen") {
                let name = newAlbumName
                let description = newAlbumDescription
                newAlbumName = ""
                newAlbumDescription = ""
                Task {
                    _ = await viewModel.createAlbum(
                        name: name,
                        description: description.isEmpty ? nil : description
                    )
                    if viewModel.errorMessage != nil {
                        showErrorAlert = true
                    }
                }
            }
            Button("Abbrechen", role: .cancel) {
                newAlbumName = ""
                newAlbumDescription = ""
            }
        }
        .alert("Fehler", isPresented: $showErrorAlert) {
            Button("OK", role: .cancel) {
                viewModel.errorMessage = nil
            }
        } message: {
            Text(viewModel.errorMessage ?? "")
        }
    }
}

struct AlbumRowView: View {
    let album: Album

    var body: some View {
        HStack(spacing: 12) {
            // Album cover thumbnail
            if let coverFilename = album.cover_filename {
                PhotoThumbnailView(filename: coverFilename)
                    .frame(width: 60, height: 60)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            } else {
                RoundedRectangle(cornerRadius: 8)
                    .fill(.quaternary)
                    .frame(width: 60, height: 60)
                    .overlay {
                        Image(systemName: "rectangle.stack")
                            .foregroundStyle(.secondary)
                    }
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(album.name)
                    .font(.headline)
                HStack {
                    Text("\(album.photo_count) Fotos")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if album.is_shared {
                        Label("Geteilt", systemImage: "person.2")
                            .font(.caption)
                            .foregroundStyle(.blue)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}
