import SwiftUI

struct AlbumDetailView: View {
    let albumId: Int
    @State private var album: Album?
    @State private var userRole: String = ""
    /// The caller's access level on this album ("owner" / "write" / "write_share"
    /// / "read"). Finer-grained than `userRole`, which collapses every writer
    /// into "contributor" — sharing is allowed for owners and write_share
    /// delegates only (issue #918).
    @State private var myAccessLevel: String = ""
    @State private var photos: [PhotoWithCuration] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var showShareSheet = false
    @State private var showSettings = false
    /// Drives the "Mit iPhone verknüpfen…" sheet (issue #812).
    @State private var syncLinkAlbum: Album?
    @State private var showUpload = false
    @State private var showDeleteConfirm = false
    @State private var isDeleting = false
    @State private var fullscreenIndex: Int = 0
    @State private var fullscreenNav: FullscreenNav? = nil
    @State private var filterSort = FilterSortViewModel()
    @State private var isSelecting = false
    @State private var selectedIds: Set<Int> = []
    @State private var shareManager = PhotoShareManager()
    @State private var addToAlbum = AddToAlbumManager()
    @State private var itemFrames: [Int: CGRect] = [:]
    @Environment(\.dismiss) private var dismiss

    // ── Album views + consensus (issue #760) ──────────────────────────────
    /// Anonymized opinion counters per photo id. Only populated for shared
    /// albums — the server omits them everywhere else.
    @State private var curationStats: [Int: PhotoCurationStats] = [:]
    @State private var isSharedAlbum = false
    @State private var viewFilter = AlbumViewFilter()
    @State private var draftViewConfig = AlbumViewConfig.default
    @State private var showViewConfig = false
    @State private var didRestoreViewFilter = false
    /// Votes cast in this session, keyed by photo id. `PhotoWithCuration` is
    /// immutable, so the grid reads its curation through `curation(_:)` — the
    /// same override pattern the fullscreen viewer uses.
    @State private var curationOverrides: [Int: CurationStatus] = [:]
    @State private var toastMessage: ToastMessage?

    private var displayedPhotos: [PhotoWithCuration] {
        let byView = viewFilter.mode == .all
            ? photos
            : photos.filter { viewFilter.matches(curation: curation($0), stats: curationStats[$0.id]) }
        let filtered = filterSort.appliedFilter.isEmpty
            ? byView
            : byView.filter { matchesFilter($0, filterSort.appliedFilter) }
        return filterSort.appliedSort.isDefault
            ? filtered
            : filtered.sorted(by: filterSort.appliedSort.comparator)
    }

    /// The current user's curation for a photo, honoring votes cast since the
    /// album was loaded.
    private func curation(_ photo: PhotoWithCuration) -> CurationStatus {
        curationOverrides[photo.id] ?? photo.curation_status
    }

    /// Participant count of this album, read off the counters the server
    /// attached (owner + shares + the AI voter). 0 for unshared albums.
    private var memberCount: Int {
        curationStats.values.map(\.memberCount).max() ?? 0
    }

    /// True when the active view — not the filter menu — is what emptied the
    /// grid, so the empty state can offer the right way out.
    private var isEmptiedByView: Bool {
        displayedPhotos.isEmpty && !photos.isEmpty && viewFilter.mode != .all
    }

    private let columns = [
        GridItem(.adaptive(minimum: 100, maximum: 150), spacing: 2)
    ]

    /// Mirrors the web app: the owner can always share, a `write_share`
    /// delegate may invite further participants and manage the public link.
    private var canShareAlbum: Bool {
        myAccessLevel == "owner" || myAccessLevel == "write_share"
            || userRole == "admin"
    }

    /// Album properties (name, description, map view) are editable with any
    /// write access — same rule as the web's `canWrite`.
    private var canEditAlbum: Bool {
        myAccessLevel == "owner" || myAccessLevel == "write" || myAccessLevel == "write_share"
            || userRole == "owner" || userRole == "admin" || userRole == "contributor"
    }

    private var canDeleteAlbum: Bool {
        userRole == "owner" || userRole == "admin"
    }

    /// "Mit iPhone verknüpfen…" needs the same write access as an upload:
    /// every mode uploads, and a read-only share would 403 on each photo.
    private var canLinkToIPhone: Bool { canEditAlbum }

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
            } else if isEmptiedByView {
                ContentUnavailableView {
                    Label("Nichts in dieser Ansicht", systemImage: viewFilter.mode.systemImage)
                } description: {
                    Text("Kein Foto erfüllt die Kriterien von „\(viewFilter.mode.label)“.")
                } actions: {
                    Button("Alle Fotos anzeigen") { selectViewMode(.all) }
                }
                .padding(.top, 60)
            } else {
                LazyVGrid(columns: columns, spacing: 2) {
                    ForEach(displayedPhotos) { photo in
                        PhotoThumbnailView(filename: photo.filename, autoCrop: photo.auto_crop)
                            .overlay(alignment: .topLeading) {
                                if isSelecting {
                                    SelectionCheckmark(isSelected: selectedIds.contains(photo.id))
                                        .padding(4)
                                }
                            }
                            .overlay(alignment: .bottomTrailing) {
                                if !isSelecting, let stats = curationStats[photo.id] {
                                    CurationStatsBadges(stats: stats)
                                }
                            }
                            .overlay(alignment: .topTrailing) {
                                if !isSelecting, curation(photo) == .favorite {
                                    Image(systemName: "heart.fill")
                                        .font(.caption2)
                                        .foregroundStyle(.pink)
                                        .shadow(radius: 2)
                                        .padding(4)
                                }
                            }
                            .contentShape(Rectangle())
                            .onTapGesture {
                                if isSelecting {
                                    toggleSelection(photo.id)
                                } else {
                                    fullscreenIndex = displayedPhotos.firstIndex(where: { $0.id == photo.id }) ?? 0
                                    fullscreenNav = FullscreenNav(startIndex: fullscreenIndex)
                                }
                            }
                            .onLongPressGesture {
                                if !isSelecting {
                                    isSelecting = true
                                    selectedIds = [photo.id]
                                }
                            }
                            // Casting a vote without leaving the grid is the
                            // point of the consensus feature — the fullscreen
                            // viewer's heart is one tap too deep when you're
                            // going through an album (issue #760).
                            .contextMenu {
                                if !isSelecting {
                                    Button {
                                        Task { await toggleFavorite(photo) }
                                    } label: {
                                        Label(
                                            curation(photo) == .favorite
                                                ? "Favorit entfernen"
                                                : "Als Favorit markieren",
                                            systemImage: curation(photo) == .favorite ? "heart.slash" : "heart"
                                        )
                                    }
                                    if let stats = curationStats[photo.id], stats.hasSignal {
                                        Section("Meinungen") {
                                            Text(consensusSummary(stats))
                                        }
                                    }
                                }
                            }
                            .reportPhotoFrame(id: photo.id, space: "albumGrid")
                    }
                }
                .padding(.horizontal, 2)
                .coordinateSpace(name: "albumGrid")
                .onPreferenceChange(PhotoFramePreference.self) { itemFrames = $0 }
                .simultaneousGesture(isSelecting ? dragSelectGesture : nil)
            }
        }
        .navigationTitle(isSelecting ? "\(selectedIds.count) ausgewählt" : (album?.name ?? "Album"))
        .navigationBarTitleDisplayMode(.large)
        .navigationDestination(item: $fullscreenNav) { nav in
            PhotoFullscreenView(
                photos: displayedPhotos,
                currentIndex: $fullscreenIndex,
                albumContext: album.map { .init(id: albumId, name: $0.name) },
                curationStats: curationStats,
                autoStartSlideshow: nav.autoStartSlideshow,
                onPhotoRemoved: { id in photos.removeAll { $0.id == id } }
            )
        }
        .sheet(isPresented: $filterSort.isMenuPresented) {
            FilterSortMenuView(viewModel: filterSort, available: [.favorite, .hasGps, .dateRange])
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $showViewConfig) {
            AlbumViewConfigSheet(
                config: $draftViewConfig,
                memberCount: memberCount,
                onApply: {
                    viewFilter = AlbumViewFilter(mode: .custom, config: draftViewConfig)
                    AlbumViewModeStore.save(viewFilter, albumId: albumId)
                }
            )
            .presentationDetents([.medium])
        }
        .toolbar {
            if isSelecting {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") {
                        isSelecting = false
                        selectedIds = []
                    }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        addToAlbum.present(photoIds: selectedIds)
                    } label: {
                        Image(systemName: "rectangle.stack.badge.plus")
                    }
                    .disabled(selectedIds.isEmpty)
                    Button {
                        let filenames = displayedPhotos.filter { selectedIds.contains($0.id) }.map(\.filename)
                        Task { await shareManager.share(filenames: filenames) }
                    } label: {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .disabled(selectedIds.isEmpty || shareManager.isLoading)
                }
            } else {
                ToolbarItem(placement: .topBarLeading) {
                    FilterSortButton(viewModel: filterSort)
                }
                ToolbarItem(placement: .topBarLeading) {
                    viewModeMenu
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        isSelecting = true
                    } label: {
                        Image(systemName: "checkmark.circle")
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showUpload = true
                    } label: {
                        Image(systemName: "photo.badge.plus")
                    }
                }
                // Sharing, properties and deletion share one overflow menu so
                // the toolbar stays usable (same pattern as the iOS media
                // library album detail).
                if canStartSlideshow || canShareAlbum || canEditAlbum || canDeleteAlbum {
                    ToolbarItem(placement: .primaryAction) {
                        Menu {
                            // Available to anyone who can see the album —
                            // playing photos back needs no edit rights.
                            if canStartSlideshow {
                                Button {
                                    fullscreenIndex = 0
                                    fullscreenNav = FullscreenNav(
                                        startIndex: 0,
                                        autoStartSlideshow: true
                                    )
                                } label: {
                                    Label("Diashow", systemImage: "play.rectangle")
                                }
                                if canShareAlbum || canEditAlbum || canDeleteAlbum {
                                    Divider()
                                }
                            }
                            if canShareAlbum {
                                Button {
                                    showShareSheet = true
                                } label: {
                                    Label("Freigeben", systemImage: "person.crop.circle.badge.plus")
                                }
                            }
                            if canLinkToIPhone, let album {
                                Button {
                                    syncLinkAlbum = album
                                } label: {
                                    Label(SyncWording.linkFromServerAlbum, systemImage: SyncWording.linkSymbol)
                                }
                            }
                            if canEditAlbum {
                                Button {
                                    showSettings = true
                                } label: {
                                    Label("Album-Einstellungen", systemImage: "gearshape")
                                }
                            }
                            if canDeleteAlbum {
                                Divider()
                                Button(role: .destructive) {
                                    showDeleteConfirm = true
                                } label: {
                                    Label("Album löschen", systemImage: "trash")
                                }
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                        }
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
        .sheet(item: $syncLinkAlbum) { album in
            AlbumSyncLinkSheet(album: album, hasWriteAccess: canLinkToIPhone)
        }
        .sheet(isPresented: $showShareSheet) {
            AlbumShareView(
                albumId: albumId,
                albumName: album?.name,
                accessLevel: myAccessLevel.isEmpty ? nil : myAccessLevel
            )
        }
        .sheet(isPresented: $showSettings) {
            if let album {
                AlbumSettingsView(
                    albumId: albumId,
                    name: album.name,
                    description: album.description,
                    displayMode: album.display_mode,
                    accessLevel: myAccessLevel.isEmpty ? nil : myAccessLevel,
                    canShare: canShareAlbum,
                    canDelete: canDeleteAlbum,
                    onSaved: { saved in applySettings(saved) },
                    onDelete: canDeleteAlbum ? { Task { await deleteAlbum() } } : nil
                )
            }
        }
        .sheet(isPresented: $shareManager.isPresented) {
            ActivityView(images: shareManager.images)
        }
        .sheet(isPresented: $addToAlbum.isPresented) {
            AddToAlbumPickerView(manager: addToAlbum)
                .presentationDetents([.medium, .large])
        }
        .overlay {
            if shareManager.isLoading {
                ZStack {
                    Color.black.opacity(0.3).ignoresSafeArea()
                    ProgressView("Fotos laden…")
                        .padding()
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                }
            }
        }
        .toast($toastMessage)
        .onChange(of: addToAlbum.resultMessage) { _, message in
            guard message != nil else { return }
            isSelecting = false
            selectedIds = []
            addToAlbum.resultMessage = nil
        }
        .task {
            await loadAlbum()
        }
    }

    // MARK: - Album views (issue #760)

    /// Preset picker for the album views. The counter-based modes are only
    /// offered on shared albums — on a solo album there is no group whose
    /// opinion could be aggregated, exactly as on the web.
    private var viewModeMenu: some View {
        Menu {
            Picker("Ansicht", selection: viewModeSelection) {
                ForEach(AlbumViewMode.available(isShared: isSharedAlbum)) { mode in
                    Label(mode.label, systemImage: mode.systemImage).tag(mode)
                }
            }
            if isSharedAlbum {
                Divider()
                Button {
                    draftViewConfig = viewFilter.config.clamped(memberCount: memberCount)
                    showViewConfig = true
                } label: {
                    Label(
                        viewFilter.summary.map { "Schwellenwerte: \($0)" } ?? "Schwellenwerte anpassen…",
                        systemImage: "slider.horizontal.3"
                    )
                }
            }
        } label: {
            Image(systemName: viewFilter.mode.systemImage)
                .symbolVariant(viewFilter.mode == .all ? .none : .fill)
        }
        .accessibilityLabel("Ansicht: \(viewFilter.mode.label)")
    }

    /// Selecting `custom` from the picker opens the threshold sheet instead of
    /// silently applying whatever was configured last.
    private var viewModeSelection: Binding<AlbumViewMode> {
        Binding(
            get: { viewFilter.mode },
            set: { newMode in
                if newMode == .custom {
                    draftViewConfig = viewFilter.config.clamped(memberCount: memberCount)
                    showViewConfig = true
                } else {
                    selectViewMode(newMode)
                }
            }
        )
    }

    private func selectViewMode(_ mode: AlbumViewMode) {
        viewFilter = AlbumViewFilter(mode: mode, config: viewFilter.config)
        AlbumViewModeStore.save(viewFilter, albumId: albumId)
    }

    private func consensusSummary(_ stats: PhotoCurationStats) -> String {
        var parts: [String] = []
        if stats.favCount > 0 {
            parts.append("\(stats.favCount) von \(stats.memberCount) favorisiert")
        }
        if stats.hideCount > 0 {
            parts.append("\(stats.hideCount) von \(stats.memberCount) ausgeblendet")
        }
        return parts.joined(separator: " · ")
    }

    /// Casts (or withdraws) the current user's favorite vote. Optimistic: the
    /// badge and heart move immediately and are rolled back if the PATCH
    /// fails, so a vote never silently disappears into the network.
    private func toggleFavorite(_ photo: PhotoWithCuration) async {
        let old = curation(photo)
        let new: CurationStatus = old == .favorite ? .visible : .favorite
        let previousStats = curationStats[photo.id]

        curationOverrides[photo.id] = new
        if let previousStats {
            curationStats[photo.id] = previousStats.applying(vote: old, to: new)
        }

        struct Body: Codable { let status: CurationStatus }
        struct Response: Codable { let success: Bool }
        do {
            _ = try await APIClient.shared.patch(
                "/photos/\(photo.id)/curation",
                body: Body(status: new)
            ) as Response
        } catch {
            curationOverrides[photo.id] = old
            curationStats[photo.id] = previousStats
            toastMessage = .error("Bewertung konnte nicht gespeichert werden.")
        }
    }

    private func toggleSelection(_ id: Int) {
        if selectedIds.contains(id) {
            selectedIds.remove(id)
            if selectedIds.isEmpty { isSelecting = false }
        } else {
            selectedIds.insert(id)
        }
    }

    private var dragSelectGesture: some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .named("albumGrid"))
            .onChanged { value in
                let point = value.location
                for (id, frame) in itemFrames where frame.contains(point) {
                    selectedIds.insert(id)
                }
            }
    }

    /// Reflects saved album properties locally (title, description, map view)
    /// so the detail view updates without another round trip.
    private func applySettings(_ saved: AlbumSettingsView.Saved) {
        guard let current = album else { return }
        album = Album(
            id: current.id,
            user_id: current.user_id,
            name: saved.name,
            description: saved.description.isEmpty ? nil : saved.description,
            cover_photo_id: current.cover_photo_id,
            cover_filename: current.cover_filename,
            display_mode: saved.displayMode,
            newest_photo_at: current.newest_photo_at,
            oldest_photo_at: current.oldest_photo_at,
            photo_count: current.photo_count,
            is_shared: current.is_shared,
            created_at: current.created_at,
            updated_at: current.updated_at,
            my_access_level: current.my_access_level
        )
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

    /// Restores the view chosen last time this album was open. Runs after the
    /// album loaded, because a stored consensus view has to be dropped when
    /// the album is no longer shared — otherwise the grid would come up empty
    /// with no obvious cause.
    private func restoreViewFilterIfNeeded() {
        guard !didRestoreViewFilter else {
            if !isSharedAlbum && viewFilter.mode.requiresSharedAlbum {
                viewFilter = AlbumViewFilter()
            }
            return
        }
        didRestoreViewFilter = true
        let stored = AlbumViewModeStore.load(albumId: albumId)
        viewFilter = (!isSharedAlbum && stored.mode.requiresSharedAlbum)
            ? AlbumViewFilter()
            : stored
        draftViewConfig = viewFilter.config
    }

    private func loadAlbum() async {
        isLoading = true
        do {
            struct AlbumResponse: Codable {
                let id: Int
                let name: String
                let description: String?
                let photos: [AlbumPhotoRow]
                let role: String?
                let my_access_level: String?
                let display_mode: String?
                /// True once the album has more than one participant (or an
                /// active public link) — the gate for the consensus views.
                let is_shared: Bool?
            }
            let response: AlbumResponse = try await APIClient.shared.get("/albums/\(albumId)")
            userRole = response.role ?? ""
            myAccessLevel = response.my_access_level ?? ""
            album = Album(
                id: response.id,
                user_id: 0,
                name: response.name,
                description: response.description,
                cover_photo_id: nil,
                cover_filename: nil,
                display_mode: response.display_mode ?? "grid",
                newest_photo_at: nil,
                oldest_photo_at: nil,
                photo_count: response.photos.count,
                is_shared: false,
                created_at: "",
                updated_at: "",
                my_access_level: response.my_access_level ?? response.role
            )
            photos = response.photos.map(\.photo)
            curationStats = Dictionary(
                response.photos.compactMap { row in row.curation_stats.map { (row.id, $0) } },
                uniquingKeysWith: { first, _ in first }
            )
            isSharedAlbum = response.is_shared ?? !curationStats.isEmpty
            // A fresh vote is only authoritative until the server answers; the
            // reload it just triggered is that answer.
            curationOverrides = [:]
            restoreViewFilterIfNeeded()
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    /// A slideshow needs something to advance to, so a single-photo album
    /// does not offer one.
    private var canStartSlideshow: Bool {
        displayedPhotos.count > 1
    }

    private struct FullscreenNav: Hashable {
        let startIndex: Int
        /// Set by the Diashow menu item so the viewer opens already playing.
        var autoStartSlideshow: Bool = false
    }
}
