import SwiftUI

struct AlbumsListView: View {
    @State private var viewModel = AlbumsViewModel()
    /// Unreviewed similar-photo groups, for the „Gruppen-Review“ row (#968).
    @State private var reviewCount = ReviewQueueCount.shared
    @State private var filterSort = AlbumFilterSortViewModel(persistenceKey: "albums.filterSort")
    @State private var showCreateSheet = false
    @State private var showErrorAlert = false
    @State private var newAlbumName = ""
    @State private var newAlbumDescription = ""
    @State private var searchText = ""
    @State private var pinnedAlbumIds: Set<Int> = AlbumPinPreferences.pinnedIds
    /// Album whose properties are being edited (sheet is driven by this).
    @State private var editingAlbum: Album?
    /// Album being linked to an iPhone album via "Mit iPhone verknüpfen…"
    /// (issue #812) — the mirror of the media library's "Mit f4mil verknüpfen…".
    @State private var syncLinkAlbum: Album?

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
                // "Alle Fotos" virtual album at the top
                Section {
                    NavigationLink(value: AllPhotosRef()) {
                        HStack(spacing: 12) {
                            RoundedRectangle(cornerRadius: 8)
                                .fill(Color.accentColor.opacity(0.15))
                                .frame(width: 60, height: 60)
                                .overlay {
                                    Image(systemName: "photo.on.rectangle")
                                        .font(.title2)
                                        .foregroundStyle(Color.accentColor)
                                }
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Alle Fotos")
                                    .font(.headline)
                                Text("Gesamte Fotomediathek")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 4)
                    }

                    NavigationLink(value: LibraryBrowserRef()) {
                        HStack(spacing: 12) {
                            RoundedRectangle(cornerRadius: 8)
                                .fill(Color.accentColor.opacity(0.15))
                                .frame(width: 60, height: 60)
                                .overlay {
                                    Image(systemName: "photo.stack")
                                        .font(.title2)
                                        .foregroundStyle(Color.accentColor)
                                }
                            VStack(alignment: .leading, spacing: 4) {
                                Text("iOS Mediathek")
                                    .font(.headline)
                                Text("Alben vom iPhone mit f4mil verknüpfen")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 4)
                    }

                    NavigationLink(value: PersonsRef()) {
                        HStack(spacing: 12) {
                            RoundedRectangle(cornerRadius: 8)
                                .fill(Color.accentColor.opacity(0.15))
                                .frame(width: 60, height: 60)
                                .overlay {
                                    Image(systemName: "person.2")
                                        .font(.title2)
                                        .foregroundStyle(Color.accentColor)
                                }
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Personen")
                                    .font(.headline)
                                Text("Automatisch erkannte Personen")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 4)
                    }

                    // The web has the review as a regular item in the photo
                    // navigation; on iOS it only ever existed as a glyph in
                    // the feed toolbar (#968, proposal 2). This is the same
                    // rank as „Alle Fotos" and „Personen" without a sixth tab
                    // for a maintenance task.
                    NavigationLink(value: GroupReviewRef()) {
                        HStack(spacing: 12) {
                            RoundedRectangle(cornerRadius: 8)
                                .fill(Color.accentColor.opacity(0.15))
                                .frame(width: 60, height: 60)
                                .overlay {
                                    Image(systemName: "checklist")
                                        .font(.title2)
                                        .foregroundStyle(Color.accentColor)
                                }
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Gruppen-Review")
                                    .font(.headline)
                                Text(ReviewQueueNotice.subtitle(reviewCount.pending))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    .badge(reviewCount.pending ?? 0)
                }

                if !pinnedAlbums.isEmpty {
                    Section {
                        ForEach(pinnedAlbums) { album in
                            NavigationLink(value: album.id) {
                                AlbumRowView(album: album, isPinned: true)
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
                            .contextMenu {
                                Button { togglePin(album.id) } label: {
                                    Label("Lösen", systemImage: "pin.slash")
                                }
                                syncToIPhoneButton(for: album)
                                albumSettingsButton(for: album)
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
                        .contextMenu {
                            Button { togglePin(album.id) } label: {
                                Label("Anpinnen", systemImage: "pin")
                            }
                            syncToIPhoneButton(for: album)
                            albumSettingsButton(for: album)
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
        .navigationDestination(for: AllPhotosRef.self) { _ in
            PhotoTimelineView()
        }
        .navigationDestination(for: LibraryBrowserRef.self) { _ in
            LibraryBrowserView()
        }
        .navigationDestination(for: PersonsRef.self) { _ in
            PersonsListView()
        }
        .navigationDestination(for: GroupReviewRef.self) { _ in
            ReviewQueueView()
        }
        .navigationDestination(for: TimelineYear.self) { year in
            PhotoYearView(year: year)
        }
        .navigationDestination(for: PhotoMonthRef.self) { ref in
            PhotoMonthGridView(year: ref.year, month: ref.month)
        }
        .sheet(isPresented: $filterSort.isMenuPresented) {
            AlbumFilterSortMenuView(viewModel: filterSort)
                .presentationDetents([.medium, .large])
        }
        // Album properties (and sharing) straight from the list — the same
        // sheet the detail view opens.
        .sheet(item: $editingAlbum) { album in
            AlbumSettingsView(
                albumId: album.id,
                name: album.name,
                description: album.description,
                displayMode: album.display_mode,
                accessLevel: album.my_access_level,
                canShare: album.my_access_level == "owner" || album.my_access_level == "write_share",
                canDelete: album.my_access_level == "owner",
                onSaved: { _ in Task { await viewModel.loadAlbums() } },
                onDelete: album.my_access_level == "owner"
                    ? { Task { await viewModel.deleteAlbum(id: album.id) } }
                    : nil
            )
        }
        .sheet(item: $syncLinkAlbum) { album in
            AlbumSyncLinkSheet(album: album)
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
        .task {
            await reviewCount.refresh()
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

    /// Context-menu entry that opens the album's properties. Shown for every
    /// album the user may write to (owner, write, write_share) — sharing and
    /// deleting are gated again inside the sheet.
    @ViewBuilder
    private func albumSettingsButton(for album: Album) -> some View {
        if album.hasWriteAccess {
            Button { editingAlbum = album } label: {
                Label("Album-Einstellungen", systemImage: "gearshape")
            }
        }
    }

    /// Starts the "make this album available on the iPhone" flow (issue #812).
    /// Requires write access: all three modes upload, and a read-only share
    /// would 403 on every photo.
    @ViewBuilder
    private func syncToIPhoneButton(for album: Album) -> some View {
        if album.hasWriteAccess {
            Button { syncLinkAlbum = album } label: {
                Label(SyncWording.linkFromServerAlbum, systemImage: SyncWording.linkSymbol)
            }
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
    var isPinned: Bool = false

    var body: some View {
        HStack(spacing: 12) {
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
                HStack(spacing: 4) {
                    Text(album.name)
                        .font(.headline)
                    if isPinned {
                        Image(systemName: "pin.fill")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                    }
                }
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
