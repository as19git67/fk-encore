import SwiftUI

struct AlbumsListView: View {
    @State private var viewModel = AlbumsViewModel()
    @State private var filterSort = AlbumFilterSortViewModel(persistenceKey: "albums.filterSort")
    @State private var showCreateSheet = false
    @State private var showErrorAlert = false
    @State private var newAlbumName = ""
    @State private var newAlbumDescription = ""
    @State private var searchText = ""
    @State private var pinnedAlbumIds: Set<Int> = AlbumPinPreferences.pinnedIds

    private var filteredAlbums: [Album] {
        let filtered = viewModel.albums.filter { filterSort.appliedFilter.matches($0) }
        let sorted = filterSort.appliedSort.isDefault
            ? filtered.sorted { ($0.newest_photo_at ?? "") > ($1.newest_photo_at ?? "") }
            : filtered.sorted(by: filterSort.appliedSort.comparator)
        guard !searchText.isEmpty else { return sorted }
        return sorted.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
    }

    private var pinnedAlbums: [Album] {
        filteredAlbums.filter { pinnedAlbumIds.contains($0.id) }
    }

    private var unpinnedAlbums: [Album] {
        filteredAlbums.filter { !pinnedAlbumIds.contains($0.id) }
    }

    var body: some View {
        List {
            if viewModel.isLoading && viewModel.albums.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .listRowSeparator(.hidden)
            } else if filteredAlbums.isEmpty && !viewModel.albums.isEmpty {
                ContentUnavailableView.search(text: searchText)
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
                if !pinnedAlbums.isEmpty {
                    Section {
                        ForEach(pinnedAlbums) { album in
                            NavigationLink(value: album.id) {
                                AlbumRowView(album: album)
                            }
                            .swipeActions(edge: .leading) {
                                Button { togglePin(album.id) } label: {
                                    Label("Lösen", systemImage: "pin.slash")
                                }
                                .tint(.orange)
                            }
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) {
                                    Task { await viewModel.deleteAlbum(id: album.id) }
                                } label: {
                                    Label("Löschen", systemImage: "trash")
                                }
                            }
                        }
                    } header: {
                        Label("Angepinnt", systemImage: "pin.fill")
                    }
                }
                Section {
                    ForEach(unpinnedAlbums) { album in
                        NavigationLink(value: album.id) {
                            AlbumRowView(album: album)
                        }
                        .swipeActions(edge: .leading) {
                            Button { togglePin(album.id) } label: {
                                Label("Anpinnen", systemImage: "pin")
                            }
                            .tint(.orange)
                        }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                Task { await viewModel.deleteAlbum(id: album.id) }
                            } label: {
                                Label("Löschen", systemImage: "trash")
                            }
                        }
                    }
                }
            }
        }
        .searchable(text: $searchText, prompt: "Album suchen")
        .navigationTitle("Alben")
        .navigationDestination(for: Int.self) { albumId in
            AlbumDetailView(albumId: albumId)
        }
        .sheet(isPresented: $filterSort.isMenuPresented) {
            AlbumFilterSortMenuView(viewModel: filterSort)
                .presentationDetents([.medium, .large])
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                AlbumFilterSortButton(viewModel: filterSort)
            }
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
                    let ok = await viewModel.createAlbum(
                        name: name,
                        description: description.isEmpty ? nil : description
                    )
                    if !ok {
                        showErrorAlert = true
                    }
                }
            }
            Button("Abbrechen", role: .cancel) {
                newAlbumName = ""
                newAlbumDescription = ""
            }
        }
        .onAppear {
            pinnedAlbumIds = AlbumPinPreferences.pinnedIds
        }
        .alert("Fehler", isPresented: $showErrorAlert) {
            Button("OK", role: .cancel) {
                viewModel.errorMessage = nil
            }
        } message: {
            Text(viewModel.errorMessage ?? "")
        }
    }

    private func togglePin(_ albumId: Int) {
        if pinnedAlbumIds.contains(albumId) {
            pinnedAlbumIds.remove(albumId)
        } else {
            pinnedAlbumIds.insert(albumId)
        }
        AlbumPinPreferences.pinnedIds = pinnedAlbumIds
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
