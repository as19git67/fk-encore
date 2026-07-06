import SwiftUI
import Photos

struct LibraryBrowserView: View {
    @State private var viewModel = LibraryBrowserViewModel()
    @State private var searchText = ""
    @State private var pendingInitialSync: PendingInitialSync?
    @State private var showError = false

    struct PendingInitialSync: Equatable {
        let iosAlbumId: String
        let albumName: String
        let assetCount: Int
    }

    private var filteredAlbums: [LibraryBrowserViewModel.IOSAlbum] {
        guard !searchText.isEmpty else { return viewModel.albums }
        return viewModel.albums.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
    }

    private var syncedAlbums: [LibraryBrowserViewModel.IOSAlbum] {
        filteredAlbums.filter { $0.syncStatus != .none }
    }

    private var unsyncedAlbums: [LibraryBrowserViewModel.IOSAlbum] {
        filteredAlbums.filter { $0.syncStatus == .none }
    }

    var body: some View {
        Group {
            if viewModel.isLoading {
                ProgressView("Mediathek laden…")
            } else if viewModel.authorizationDenied {
                ContentUnavailableView {
                    Label("Kein Zugriff", systemImage: "photo.on.rectangle.angled")
                } description: {
                    Text("Bitte erlaube den Zugriff auf die Fotos-Mediathek in den Einstellungen.")
                } actions: {
                    Button("Einstellungen öffnen") {
                        if let url = URL(string: UIApplication.openSettingsURLString) {
                            UIApplication.shared.open(url)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                }
            } else if viewModel.albums.isEmpty {
                ContentUnavailableView {
                    Label("Keine Alben", systemImage: "photo.on.rectangle.angled")
                } description: {
                    Text("Die iOS-Mediathek enthält keine Alben mit Fotos.")
                }
            } else {
                albumList
            }
        }
        .navigationTitle("iOS Mediathek")
        .navigationDestination(for: LibraryBrowserViewModel.IOSAlbum.self) { album in
            LibraryAlbumDetailView(album: album, viewModel: viewModel)
        }
        .task {
            await viewModel.load()
        }
        .refreshable {
            await viewModel.load()
        }
        .alert("Fehler", isPresented: $showError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(viewModel.errorMessage ?? "")
        }
        .confirmationDialog(
            initialSyncTitle,
            isPresented: Binding(
                get: { pendingInitialSync != nil },
                set: { if !$0 { pendingInitialSync = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Alle Fotos hochladen") {
                if let albumId = pendingInitialSync?.iosAlbumId {
                    PhotoSyncPreferences.resetAlbumSyncDate(for: albumId)
                }
                pendingInitialSync = nil
            }
            Button("Nur neue ab jetzt") {
                pendingInitialSync = nil
            }
            Button("Abbrechen", role: .cancel) {
                pendingInitialSync = nil
            }
        } message: {
            Text(initialSyncMessage)
        }
    }

    private var initialSyncTitle: String {
        guard let item = pendingInitialSync else { return "" }
        return "Album \"\(item.albumName)\""
    }

    private var initialSyncMessage: String {
        guard let item = pendingInitialSync else { return "" }
        if item.assetCount > 0 {
            return "Sollen alle \(item.assetCount) Fotos dieses Albums hochgeladen werden oder nur neue ab jetzt?"
        }
        return "Sollen alle bisherigen Fotos hochgeladen werden oder nur neue ab jetzt?"
    }

    @ViewBuilder
    private var albumList: some View {
        List {
            if !syncedAlbums.isEmpty {
                Section {
                    ForEach(syncedAlbums) { album in
                        NavigationLink(value: album) {
                            LibraryAlbumRow(album: album)
                        }
                        .swipeActions(edge: .trailing) {
                            if album.canDisconnect {
                                Button(role: .destructive) {
                                    viewModel.disconnect(album)
                                } label: {
                                    Label("Trennen", systemImage: "link.badge.plus")
                                }
                            }
                        }
                    }
                } header: {
                    Text("Synchronisiert")
                }
            }

            Section {
                if unsyncedAlbums.isEmpty && !filteredAlbums.isEmpty {
                    Text("Alle Alben werden synchronisiert.")
                        .foregroundStyle(.secondary)
                        .font(.subheadline)
                } else {
                    ForEach(unsyncedAlbums) { album in
                        NavigationLink(value: album) {
                            LibraryAlbumRow(album: album)
                        }
                        .swipeActions(edge: .leading) {
                            if album.canMakeAvailable {
                                Button {
                                    Task { await handleMakeAvailable(album) }
                                } label: {
                                    Label("Verfügbar machen", systemImage: "arrow.up.circle")
                                }
                                .tint(.blue)
                            }
                        }
                    }
                }
            } header: {
                if !syncedAlbums.isEmpty {
                    Text("Nicht synchronisiert")
                }
            }
        }
        .searchable(text: $searchText, prompt: "Album suchen")
        .overlay {
            if viewModel.isMakingAvailable {
                Color.black.opacity(0.3)
                    .ignoresSafeArea()
                    .overlay {
                        ProgressView("Wird eingerichtet…")
                            .padding()
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                    }
            }
        }
    }

    private func handleMakeAvailable(_ album: LibraryBrowserViewModel.IOSAlbum) async {
        let result = await viewModel.makeAvailable(album)
        switch result {
        case .success(_, let albumName, let assetCount, let iosAlbumId):
            pendingInitialSync = PendingInitialSync(
                iosAlbumId: iosAlbumId,
                albumName: albumName,
                assetCount: assetCount
            )
        case .error(let message):
            viewModel.errorMessage = message
            showError = true
        }
    }
}

// MARK: - Album Row

private struct LibraryAlbumRow: View {
    let album: LibraryBrowserViewModel.IOSAlbum

    var body: some View {
        HStack(spacing: 12) {
            LibraryAlbumCover(localIdentifier: album.id)
                .frame(width: 60, height: 60)
                .clipShape(RoundedRectangle(cornerRadius: 8))

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(album.name)
                        .font(.headline)
                    if album.isSmart {
                        Image(systemName: "gearshape")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 8) {
                    Text("\(album.assetCount) Foto\(album.assetCount == 1 ? "" : "s")")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    SyncStatusBadge(status: album.syncStatus)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Sync Status Badge

struct SyncStatusBadge: View {
    let status: LibraryBrowserViewModel.IOSAlbum.SyncStatus

    var body: some View {
        switch status {
        case .none:
            EmptyView()
        case .copy:
            Label("kopiert", systemImage: "arrow.up")
                .font(.caption2)
                .foregroundStyle(.white)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(.blue, in: Capsule())
        }
    }
}

// MARK: - Album Cover Thumbnail

struct LibraryAlbumCover: View {
    let localIdentifier: String
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Rectangle()
                    .fill(.quaternary)
                    .overlay {
                        Image(systemName: "photo")
                            .foregroundStyle(.secondary)
                    }
            }
        }
        .task(id: localIdentifier) {
            image = await loadCover()
        }
    }

    private func loadCover() async -> UIImage? {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let collections = PHAssetCollection.fetchAssetCollections(
                    withLocalIdentifiers: [localIdentifier], options: nil
                )
                guard let collection = collections.firstObject else {
                    continuation.resume(returning: nil)
                    return
                }

                let fetchOptions = PHFetchOptions()
                fetchOptions.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
                fetchOptions.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
                fetchOptions.fetchLimit = 1

                guard let asset = PHAsset.fetchAssets(in: collection, options: fetchOptions).firstObject else {
                    continuation.resume(returning: nil)
                    return
                }

                let options = PHImageRequestOptions()
                options.deliveryMode = .opportunistic
                options.resizeMode = .fast
                options.isSynchronous = true

                var result: UIImage?
                PHImageManager.default().requestImage(
                    for: asset,
                    targetSize: CGSize(width: 120, height: 120),
                    contentMode: .aspectFill,
                    options: options
                ) { image, _ in
                    result = image
                }
                continuation.resume(returning: result)
            }
        }
    }
}
