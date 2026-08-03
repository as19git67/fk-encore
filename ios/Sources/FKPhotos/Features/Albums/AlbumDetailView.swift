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
    /// Drives the "Mit iPhone synchronisieren…" sheet (issue #812).
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

    /// "Mit iPhone synchronisieren…" needs the same write access as an upload:
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
        .navigationDestination(item: $fullscreenNav) { _ in
            PhotoFullscreenView(
                photos: displayedPhotos,
                currentIndex: $fullscreenIndex,
                albumContext: album.map { .init(id: albumId, name: $0.name) },
                onPhotoRemoved: { id in photos.removeAll { $0.id == id } }
            )
        }
        .sheet(isPresented: $filterSort.isMenuPresented) {
            FilterSortMenuView(viewModel: filterSort, available: [.favorite, .hasGps, .dateRange])
                .presentationDetents([.medium, .large])
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
                if canShareAlbum || canEditAlbum || canDeleteAlbum {
                    ToolbarItem(placement: .primaryAction) {
                        Menu {
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
                                    Label("Mit iPhone synchronisieren…", systemImage: "iphone.and.arrow.forward")
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

    private func loadAlbum() async {
        isLoading = true
        do {
            struct AlbumResponse: Codable {
                let id: Int
                let name: String
                let description: String?
                let photos: [PhotoWithCuration]
                let role: String?
                let my_access_level: String?
                let display_mode: String?
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
            photos = response.photos
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private struct FullscreenNav: Hashable {
        let startIndex: Int
    }
}
