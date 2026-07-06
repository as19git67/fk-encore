import SwiftUI
import Photos

struct LibraryAlbumDetailView: View {
    let album: LibraryBrowserViewModel.IOSAlbum
    var viewModel: LibraryBrowserViewModel

    @State private var assets: [PHAsset] = []
    @State private var isLoading = true
    @State private var selectedAssetIndex: Int = 0
    @State private var showFullscreen = false
    @State private var showDisconnectConfirm = false
    @State private var pendingInitialSync: LibraryBrowserView.PendingInitialSync?
    @State private var showError = false
    @State private var errorMessage: String?
    @State private var syncStatus: LibraryBrowserViewModel.IOSAlbum.SyncStatus
    @State private var isLinked: Bool

    init(album: LibraryBrowserViewModel.IOSAlbum, viewModel: LibraryBrowserViewModel) {
        self.album = album
        self.viewModel = viewModel
        self._syncStatus = State(initialValue: album.syncStatus)
        self._isLinked = State(initialValue: album.isIndividuallySynced)
    }

    private var canMakeAvailable: Bool { syncStatus == .none && !album.isSmart }
    private var canDisconnect: Bool { isLinked }

    private let columns = [
        GridItem(.adaptive(minimum: 100, maximum: 150), spacing: 2)
    ]

    var body: some View {
        Group {
            if isLoading {
                ProgressView("Fotos laden…")
            } else if assets.isEmpty {
                ContentUnavailableView {
                    Label("Keine Fotos", systemImage: "photo")
                } description: {
                    Text("Dieses Album enthält keine Fotos.")
                }
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, spacing: 2) {
                        ForEach(Array(assets.enumerated()), id: \.element.localIdentifier) { index, asset in
                            LibraryPhotoCell(asset: asset)
                                .aspectRatio(1, contentMode: .fill)
                                .clipped()
                                .onTapGesture {
                                    selectedAssetIndex = index
                                    showFullscreen = true
                                }
                        }
                    }
                }
            }
        }
        .navigationTitle(album.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .bottomBar) {
                HStack {
                    SyncStatusBadge(status: syncStatus)
                    Spacer()
                    Text("\(assets.count) Foto\(assets.count == 1 ? "" : "s")")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if canMakeAvailable {
                    Button {
                        Task { await handleMakeAvailable() }
                    } label: {
                        Image(systemName: "link.badge.plus")
                    }
                    .disabled(viewModel.isMakingAvailable)
                } else if canDisconnect {
                    Button(role: .destructive) {
                        showDisconnectConfirm = true
                    } label: {
                        Image(systemName: "minus.circle")
                    }
                }
            }
        }
        .task {
            assets = await loadAssets()
            isLoading = false
        }
        .fullScreenCover(isPresented: $showFullscreen) {
            if !assets.isEmpty {
                LibraryPhotoFullscreenView(
                    assets: assets,
                    currentIndex: $selectedAssetIndex
                )
            }
        }
        .confirmationDialog(
            "Verknüpfung lösen?",
            isPresented: $showDisconnectConfirm,
            titleVisibility: .visible
        ) {
            Button("Verknüpfung lösen", role: .destructive) {
                viewModel.disconnect(album)
                syncStatus = .none
                isLinked = false
            }
            Button("Abbrechen", role: .cancel) {}
        } message: {
            Text("Das Album \"\(album.name)\" wird nicht mehr automatisch hochgeladen. Bereits hochgeladene Fotos bleiben auf dem Server.")
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
        .alert("Fehler", isPresented: $showError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
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

    private func handleMakeAvailable() async {
        let result = await viewModel.makeAvailable(album)
        switch result {
        case .success(_, let albumName, let assetCount, let iosAlbumId):
            syncStatus = .copy
            isLinked = true
            pendingInitialSync = LibraryBrowserView.PendingInitialSync(
                iosAlbumId: iosAlbumId,
                albumName: albumName,
                assetCount: assetCount
            )
        case .error(let message):
            errorMessage = message
            showError = true
        }
    }

    private func loadAssets() async -> [PHAsset] {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let collections = PHAssetCollection.fetchAssetCollections(
                    withLocalIdentifiers: [album.id], options: nil
                )
                guard let collection = collections.firstObject else {
                    continuation.resume(returning: [])
                    return
                }

                let fetchOptions = PHFetchOptions()
                fetchOptions.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
                fetchOptions.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)

                let result = PHAsset.fetchAssets(in: collection, options: fetchOptions)
                var list: [PHAsset] = []
                list.reserveCapacity(result.count)
                result.enumerateObjects { asset, _, _ in
                    list.append(asset)
                }
                continuation.resume(returning: list)
            }
        }
    }
}

// MARK: - Photo Grid Cell

struct LibraryPhotoCell: View {
    let asset: PHAsset
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
            }
        }
        .task(id: asset.localIdentifier) {
            image = await loadThumbnail()
        }
    }

    private func loadThumbnail() async -> UIImage? {
        await withCheckedContinuation { continuation in
            let options = PHImageRequestOptions()
            options.deliveryMode = .opportunistic
            options.resizeMode = .fast
            options.isSynchronous = true

            DispatchQueue.global(qos: .userInitiated).async {
                var result: UIImage?
                PHImageManager.default().requestImage(
                    for: asset,
                    targetSize: CGSize(width: 200, height: 200),
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
