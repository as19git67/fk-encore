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
    @State private var showModeChoice = false
    @State private var pendingInitialSync: LibraryBrowserView.PendingInitialSync?
    @State private var showError = false
    @State private var errorMessage: String?
    @State private var syncStatus: LibraryBrowserViewModel.IOSAlbum.SyncStatus
    @State private var isLinked: Bool
    /// Asset(s) queued for the one-off "Nach f4mil kopieren…" flow (issue #812).
    @State private var copyRequest: LibraryPhotoCopyRequest?
    @State private var toastMessage: ToastMessage?
    /// Multi-select for copying a batch in one go. Keyed by `localIdentifier`
    /// rather than grid index so a reload can't silently reassign the selection
    /// to different photos.
    @State private var isSelecting = false
    @State private var selectedAssetIds: Set<String> = []
    /// Grid-cell frames by index, for the drag-select hit test. Index-keyed
    /// because the shared `PhotoFramePreference` is `[Int: CGRect]`; resolved
    /// back to a `localIdentifier` before anything is selected.
    @State private var itemFrames: [Int: CGRect] = [:]

    init(album: LibraryBrowserViewModel.IOSAlbum, viewModel: LibraryBrowserViewModel) {
        self.album = album
        self.viewModel = viewModel
        self._syncStatus = State(initialValue: album.syncStatus)
        self._isLinked = State(initialValue: album.isIndividuallySynced)
    }

    private var canMakeAvailable: Bool { syncStatus == .none }
    private var canDisconnect: Bool { isLinked }

    /// Two-way binding for the linked album's sync mode. Reads the *persisted*
    /// mode rather than deriving it from `syncStatus`, because a parked link
    /// (`.revoked`) has no mode of its own to derive from and would otherwise
    /// always read back as "Kopieren".
    private var syncModeBinding: Binding<PhotoSyncMode> {
        Binding(
            get: { PhotoSyncPreferences.albumSyncMode(for: album.id) },
            set: { newMode in
                viewModel.setSyncMode(newMode, for: album)
                // A revoked link keeps its badge until access is restored — the
                // mode change doesn't reactivate it.
                if syncStatus != .revoked {
                    syncStatus = LibraryBrowserViewModel.status(for: newMode)
                }
            }
        )
    }

    private let columns = [
        GridItem(.adaptive(minimum: 100, maximum: 150), spacing: 2)
    ]

    var body: some View {
        VStack(spacing: 0) {
            if syncStatus == .revoked {
                revokedNotice
            }
            content
        }
        .navigationTitle(isSelecting ? "\(selectedAssetIds.count) ausgewählt" : album.name)
        .navigationBarTitleDisplayMode(isSelecting ? .inline : .large)
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
            if isSelecting {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { endSelection() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(selectedAssetIds.count == assets.count ? "Keins" : "Alle") {
                        selectedAssetIds = selectedAssetIds.count == assets.count
                            ? []
                            : Set(assets.map(\.localIdentifier))
                    }
                    .disabled(assets.isEmpty)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        copySelection()
                    } label: {
                        Image(systemName: "square.and.arrow.up.on.square")
                    }
                    .disabled(selectedAssetIds.isEmpty)
                }
            }
        }
        .toolbar {
            // Entering multi-select needs a visible affordance — the context
            // menu alone would leave batch copying undiscoverable.
            ToolbarItem(placement: .primaryAction) {
                if !isSelecting && !assets.isEmpty {
                    Button {
                        isSelecting = true
                        selectedAssetIds = []
                    } label: {
                        Image(systemName: "checkmark.circle")
                    }
                }
            }
            ToolbarItem(placement: .primaryAction) {
                if isSelecting {
                    EmptyView()
                } else if canMakeAvailable {
                    Button {
                        showModeChoice = true
                    } label: {
                        Image(systemName: "link.badge.plus")
                    }
                    .disabled(viewModel.isMakingAvailable)
                } else if canDisconnect {
                    Menu {
                        Picker("Modus", selection: syncModeBinding) {
                            Label("Kopieren", systemImage: "arrow.up").tag(PhotoSyncMode.copy)
                            Label("Synchronisieren", systemImage: "arrow.triangle.2.circlepath").tag(PhotoSyncMode.sync)
                            Label("Zwei-Wege", systemImage: "arrow.left.arrow.right").tag(PhotoSyncMode.bisync)
                        }
                        Divider()
                        Button(role: .destructive) {
                            showDisconnectConfirm = true
                        } label: {
                            Label("Trennen", systemImage: "minus.circle")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
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
        .sheet(item: $copyRequest) { request in
            LibraryPhotoCopySheet(assets: request.assets) { message in
                toastMessage = message
                // The batch is on its way; keeping the grid in selection mode
                // would invite an accidental second copy of the same photos.
                endSelection()
            }
        }
        .toast($toastMessage)
        .alert(
            "Album \"\(album.name)\" verfügbar machen",
            isPresented: $showModeChoice
        ) {
            Button("Kopieren") {
                Task { await handleMakeAvailable(mode: .copy) }
            }
            Button("Synchronisieren") {
                Task { await handleMakeAvailable(mode: .sync) }
            }
            Button("Zwei-Wege") {
                Task { await handleMakeAvailable(mode: .bisync) }
            }
            Button("Abbrechen", role: .cancel) {}
        } message: {
            Text(LibraryBrowserViewModel.modeChoiceExplanation)
        }
        .alert(
            "Verknüpfung trennen?",
            isPresented: $showDisconnectConfirm
        ) {
            Button("Trennen", role: .destructive) {
                viewModel.disconnect(album)
                syncStatus = .none
                isLinked = false
            }
            Button("Abbrechen", role: .cancel) {}
        } message: {
            Text("Das Album \"\(album.name)\" wird nicht mehr automatisch hochgeladen. Bereits hochgeladene Fotos bleiben auf dem Server.")
        }
        .alert(
            initialSyncTitle,
            isPresented: Binding(
                get: { pendingInitialSync != nil },
                set: { if !$0 { pendingInitialSync = nil } }
            )
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

    @ViewBuilder
    private var content: some View {
        if isLoading {
            ProgressView("Fotos laden…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
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
                            .overlay(alignment: .topLeading) {
                                if isSelecting {
                                    SelectionCheckmark(
                                        isSelected: selectedAssetIds.contains(asset.localIdentifier)
                                    )
                                    .padding(4)
                                }
                            }
                            .contentShape(Rectangle())
                            .onTapGesture {
                                if isSelecting {
                                    toggleSelection(asset.localIdentifier)
                                } else {
                                    selectedAssetIndex = index
                                    showFullscreen = true
                                }
                            }
                            // Long-press stays the context menu rather than
                            // becoming "enter selection mode": the toolbar
                            // already offers that, and the one-tap single copy
                            // is worth keeping. Both branches always yield at
                            // least one item — an empty @ViewBuilder here would
                            // pop a blank menu.
                            .contextMenu {
                                if isSelecting {
                                    Button {
                                        copySelection(including: asset)
                                    } label: {
                                        Label("Auswahl kopieren…", systemImage: "square.and.arrow.up.on.square")
                                    }
                                } else {
                                    Button {
                                        copyRequest = LibraryPhotoCopyRequest(asset)
                                    } label: {
                                        Label("Nach f4mil kopieren…", systemImage: "square.and.arrow.up.on.square")
                                    }
                                    Button {
                                        isSelecting = true
                                        selectedAssetIds = [asset.localIdentifier]
                                    } label: {
                                        Label("Mehrere auswählen", systemImage: "checkmark.circle")
                                    }
                                }
                            }
                            .reportPhotoFrame(id: index, space: "libraryGrid")
                    }
                }
                .padding(.horizontal, 2)
                .coordinateSpace(name: "libraryGrid")
                .onPreferenceChange(PhotoFramePreference.self) { itemFrames = $0 }
                .simultaneousGesture(isSelecting ? dragSelectGesture : nil)
            }
        }
    }

    // MARK: - Multi-select

    /// Swipe across the grid to select a run of photos, matching the album
    /// detail view's gesture. Additive only: dragging never *deselects*, so a
    /// wobbly finger can't silently undo part of the selection.
    private var dragSelectGesture: some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .named("libraryGrid"))
            .onChanged { value in
                let point = value.location
                for (index, frame) in itemFrames where frame.contains(point) {
                    guard assets.indices.contains(index) else { continue }
                    selectedAssetIds.insert(assets[index].localIdentifier)
                }
            }
    }

    private func toggleSelection(_ localIdentifier: String) {
        if selectedAssetIds.contains(localIdentifier) {
            selectedAssetIds.remove(localIdentifier)
        } else {
            selectedAssetIds.insert(localIdentifier)
        }
    }

    private func endSelection() {
        isSelecting = false
        selectedAssetIds = []
    }

    /// Hands the current selection to the copy sheet, in grid order so the
    /// upload queue mirrors what the user sees.
    ///
    /// `extra` is the photo a context menu was opened on: long-pressing a photo
    /// that isn't selected yet should include it rather than quietly copy
    /// everything *except* the one under the finger. Resolved into a local set
    /// first so the copy never depends on the `@State` write landing first.
    private func copySelection(including extra: PHAsset? = nil) {
        var ids = selectedAssetIds
        if let extra { ids.insert(extra.localIdentifier) }
        let selected = assets.filter { ids.contains($0.localIdentifier) }
        guard !selected.isEmpty else { return }
        selectedAssetIds = ids
        copyRequest = LibraryPhotoCopyRequest(selected)
    }

    /// Shown when the linked server album is gone or no longer writable
    /// (issue #812). The link is kept — access may come back — but nothing syncs
    /// meanwhile, and silently doing nothing would look like a bug.
    private var revokedNotice: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Kein Zugriff mehr auf das f4mil-Album")
                    .font(.subheadline.weight(.semibold))
                Text("Die Freigabe wurde entzogen oder auf Nur-Lesen gesetzt. Es wird nichts mehr übertragen. Sobald du wieder Bearbeiten-Rechte hast, läuft die Synchronisierung von selbst weiter.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(.orange.opacity(0.12))
    }

    private var initialSyncTitle: String {
        guard let item = pendingInitialSync else { return "" }
        return "Album \"\(item.albumName)\""
    }

    private var initialSyncMessage: String {
        guard let item = pendingInitialSync else { return "" }
        return LibraryBrowserView.initialSyncPrompt(for: item)
    }

    private func handleMakeAvailable(mode: PhotoSyncMode) async {
        let result = await viewModel.makeAvailable(album, mode: mode)
        switch result {
        case .success(_, let albumName, let assetCount, let iosAlbumId, let resolution):
            syncStatus = LibraryBrowserViewModel.status(for: mode)
            isLinked = true
            pendingInitialSync = LibraryBrowserView.PendingInitialSync(
                iosAlbumId: iosAlbumId,
                albumName: albumName,
                assetCount: assetCount,
                joinedSharedAlbum: resolution == .sharedAlbum
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
        Color.clear
            .aspectRatio(1, contentMode: .fill)
            .overlay {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                } else {
                    Rectangle()
                        .fill(.quaternary)
                }
            }
            .clipped()
            .contentShape(Rectangle())
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
