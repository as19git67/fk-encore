import SwiftUI
import Photos

struct SyncSettingsView: View {
    @AppStorage("sync.enabled")   private var syncEnabled = false
    @AppStorage("sync.wifiOnly")  private var wifiOnly    = true
    @AppStorage("sync.onlyNew")   private var onlyNew     = true
    @AppStorage("sync.albumMode") private var albumMode   = "all"

    @State private var selectedAlbumIds: Set<String> = PhotoSyncPreferences.selectedAlbumIds
    @State private var albumServerMappings: [String: Int] = PhotoSyncPreferences.albumMappings
    @State private var allPhotosAlbumId: Int? = PhotoSyncPreferences.allPhotosTargetAlbumId
    @State private var serverAlbums: [Album] = []
    @State private var iosAlbumNames: [String: String] = [:]
    @State private var showAuthAlert = false
    @State private var refreshTick   = 0  // Bump to re-read status values
    @State private var showResetConfirm = false
    @State private var isSyncing     = false
    @State private var syncError: String?

    private var lastSyncDate:   Date? { PhotoSyncPreferences.lastSyncDate }
    private var uploadedCount:  Int   { PhotoSyncPreferences.uploadedCount }

    var body: some View {
        Form {
            // ── Master toggle ──────────────────────────────────────────
            Section {
                Toggle("Automatisch hochladen", isOn: $syncEnabled)
            } footer: {
                Text("Fotos werden automatisch im Hintergrund zum Server hochgeladen.")
            }

            // ── What to upload ─────────────────────────────────────────
            if syncEnabled {
                Section {
                    Picker("Quelle", selection: $albumMode) {
                        Text("Alle Fotos").tag("all")
                        Text("Ausgewählte Alben").tag("selected")
                    }
                    .pickerStyle(.menu)

                    if albumMode == "selected" {
                        NavigationLink {
                            AlbumPickerView(selectedIds: $selectedAlbumIds)
                                .onChange(of: selectedAlbumIds) { _, newValue in
                                    PhotoSyncPreferences.selectedAlbumIds = newValue
                                    // Remove server mappings for deselected albums
                                    let removed = albumServerMappings.keys.filter { !newValue.contains($0) }
                                    if !removed.isEmpty {
                                        for id in removed { albumServerMappings.removeValue(forKey: id) }
                                        PhotoSyncPreferences.albumMappings = albumServerMappings
                                    }
                                    Task { await loadIosAlbumNames() }
                                }
                        } label: {
                            HStack {
                                Text("Alben auswählen")
                                Spacer()
                                Text(selectedAlbumIds.isEmpty
                                     ? "Keine gewählt"
                                     : "\(selectedAlbumIds.count) gewählt")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }

                    Toggle("Nur neue Fotos", isOn: $onlyNew)
                } header: {
                    Text("Fotos")
                } footer: {
                    Text("Mit 'Nur neue Fotos' werden ausschliesslich Bilder hochgeladen, die seit dem letzten Sync aufgenommen wurden.")
                }

                // ── Server album for "Alle Fotos" ──────────────────────
                if albumMode == "all" {
                    Section {
                        NavigationLink {
                            ServerAlbumPickerView(
                                title: "Ziel-Album",
                                selectedAlbumId: allPhotosAlbumBinding
                            )
                        } label: {
                            HStack {
                                Text("Server Album")
                                Spacer()
                                Text(serverAlbumName(for: allPhotosAlbumId) ?? "Kein Album")
                                    .foregroundStyle(allPhotosAlbumId != nil ? .secondary : .tertiary)
                            }
                        }
                    } footer: {
                        Text("Alle hochgeladenen Fotos werden diesem Server-Album hinzugefügt.")
                    }
                }

                // ── Per-album server mapping for "Ausgewählte Alben" ───
                if albumMode == "selected" && !selectedAlbumIds.isEmpty {
                    Section("Album Zuordnungen") {
                        ForEach(sortedSelectedAlbumIds, id: \.self) { iosId in
                            NavigationLink {
                                ServerAlbumPickerView(
                                    title: iosAlbumNames[iosId] ?? "Album",
                                    selectedAlbumId: serverAlbumBinding(for: iosId)
                                )
                            } label: {
                                HStack {
                                    Text(iosAlbumNames[iosId] ?? iosId)
                                    Spacer()
                                    Text(serverAlbumName(for: albumServerMappings[iosId]) ?? "Kein Album")
                                        .foregroundStyle(albumServerMappings[iosId] != nil ? .secondary : .tertiary)
                                }
                            }
                        }
                    }
                }

                // ── Network ────────────────────────────────────────────
                Section {
                    Toggle("Nur WLAN", isOn: $wifiOnly)
                } header: {
                    Text("Netzwerk")
                } footer: {
                    Text("Wenn aktiviert, werden Fotos nur über WLAN hochgeladen.")
                }

                // ── Manual trigger ─────────────────────────────────────
                Section {
                    Button {
                        syncError = nil
                        isSyncing = true
                        Task {
                            do {
                                try await PhotoSyncService.shared.sync()
                            } catch {
                                syncError = error.localizedDescription
                            }
                            isSyncing = false
                            refreshTick += 1
                        }
                    } label: {
                        HStack {
                            Text("Jetzt synchronisieren")
                            Spacer()
                            if isSyncing {
                                ProgressView()
                            }
                        }
                    }
                    .disabled(isSyncing)

                    if let error = syncError {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }

            // ── Debug ──────────────────────────────────────────────────
            #if DEBUG
            Section("Debug") {
                Button("Jetzt synchronisieren") {
                    Task { try? await PhotoSyncService.shared.sync() }
                }
                .foregroundStyle(Color.accentColor)
                Button("Hintergrund-Task einplanen") {
                    BackgroundSyncManager.shared.scheduleNextSyncIfNeeded()
                }
                .foregroundStyle(Color.accentColor)
            }
            #endif

            // ── Status ─────────────────────────────────────────────────
            Section("Status") {
                LabeledContent("Letzter Upload") {
                    if let date = lastSyncDate {
                        Text(date, style: .relative)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("Noch nie")
                            .foregroundStyle(.secondary)
                    }
                }
                LabeledContent("Hochgeladene Fotos") {
                    Text("\(uploadedCount)")
                        .foregroundStyle(.secondary)
                }
                Button(role: .destructive) {
                    showResetConfirm = true
                } label: {
                    Text("Upload-Verlauf zurücksetzen")
                }
            }
            .id(refreshTick)  // Force re-render when tick changes
            .confirmationDialog(
                "Upload-Verlauf zurücksetzen?",
                isPresented: $showResetConfirm,
                titleVisibility: .visible
            ) {
                Button("Zurücksetzen", role: .destructive) {
                    PhotoSyncPreferences.resetUploadHistory()
                    refreshTick += 1
                }
                Button("Abbrechen", role: .cancel) {}
            } message: {
                Text("Alle Fotos werden beim nächsten Sync erneut geprüft und ggf. hochgeladen.")
            }
        }
        .navigationTitle("Automatisch hochladen")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            selectedAlbumIds = PhotoSyncPreferences.selectedAlbumIds
            albumServerMappings = PhotoSyncPreferences.albumMappings
            allPhotosAlbumId = PhotoSyncPreferences.allPhotosTargetAlbumId
            refreshTick += 1
        }
        .task {
            await loadServerAlbums()
            await loadIosAlbumNames()
        }
        .alert("Zugriff verweigert", isPresented: $showAuthAlert) {
            Button("Einstellungen öffnen") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
            Button("Abbrechen", role: .cancel) {
                syncEnabled = false
            }
        } message: {
            Text("Bitte erlaube den Zugriff auf die Fotos in den Einstellungen der App.")
        }
        .onChange(of: syncEnabled) { _, enabled in
            if enabled {
                Task {
                    let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
                    await MainActor.run {
                        if status == .denied || status == .restricted {
                            syncEnabled = false
                            showAuthAlert = true
                        } else {
                            BackgroundSyncManager.shared.scheduleNextSyncIfNeeded()
                        }
                    }
                }
            } else {
                BackgroundSyncManager.shared.scheduleNextSyncIfNeeded()  // cancels when disabled
            }
        }
    }

    // MARK: - Helpers

    private var sortedSelectedAlbumIds: [String] {
        Array(selectedAlbumIds).sorted { id1, id2 in
            (iosAlbumNames[id1] ?? id1) < (iosAlbumNames[id2] ?? id2)
        }
    }

    private func serverAlbumName(for albumId: Int?) -> String? {
        guard let albumId else { return nil }
        return serverAlbums.first { $0.id == albumId }?.name
    }

    private var allPhotosAlbumBinding: Binding<Int?> {
        Binding(
            get: { allPhotosAlbumId },
            set: {
                allPhotosAlbumId = $0
                PhotoSyncPreferences.allPhotosTargetAlbumId = $0
                Task { await loadServerAlbums() }
            }
        )
    }

    private func serverAlbumBinding(for iosId: String) -> Binding<Int?> {
        Binding(
            get: { albumServerMappings[iosId] },
            set: { newValue in
                if let v = newValue {
                    albumServerMappings[iosId] = v
                } else {
                    albumServerMappings.removeValue(forKey: iosId)
                }
                PhotoSyncPreferences.albumMappings = albumServerMappings
                Task { await loadServerAlbums() }
            }
        )
    }

    private func loadServerAlbums() async {
        do {
            let response: ListAlbumsResponse = try await APIClient.shared.get("/albums")
            serverAlbums = response.albums
        } catch {}
    }

    private func loadIosAlbumNames() async {
        let ids = Array(selectedAlbumIds)
        guard !ids.isEmpty else { return }
        iosAlbumNames = await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                var result: [String: String] = [:]
                PHAssetCollection
                    .fetchAssetCollections(withLocalIdentifiers: ids, options: nil)
                    .enumerateObjects { collection, _, _ in
                        if let title = collection.localizedTitle {
                            result[collection.localIdentifier] = title
                        }
                    }
                continuation.resume(returning: result)
            }
        }
    }
}

// MARK: - Album Picker

struct AlbumPickerView: View {
    @Binding var selectedIds: Set<String>

    @State private var albums: [(collection: PHAssetCollection, count: Int)] = []
    @State private var isLoading = true
    @State private var searchText = ""

    private var filteredAlbums: [(collection: PHAssetCollection, count: Int)] {
        guard !searchText.isEmpty else { return albums }
        return albums.filter {
            ($0.collection.localizedTitle ?? "").localizedCaseInsensitiveContains(searchText)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Album suchen", text: $searchText)
                    .autocorrectionDisabled()
                if !searchText.isEmpty {
                    Button { searchText = "" } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(8)
            .background(.quaternary)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal)
            .padding(.vertical, 8)

            List {
                if isLoading {
                    ProgressView("Alben laden…")
                        .frame(maxWidth: .infinity)
                        .padding()
                } else if albums.isEmpty {
                    ContentUnavailableView {
                        Label("Keine Alben", systemImage: "photo.on.rectangle.angled")
                    } description: {
                        Text("Es wurden keine Alben mit Fotos gefunden.")
                    }
                } else if filteredAlbums.isEmpty {
                    ContentUnavailableView {
                        Label("Keine Treffer", systemImage: "magnifyingglass")
                    } description: {
                        Text("Kein Album entspricht \"\(searchText)\".")
                    }
                } else {
                    ForEach(filteredAlbums, id: \.collection.localIdentifier) { item in
                        Button {
                            let id = item.collection.localIdentifier
                            if selectedIds.contains(id) {
                                selectedIds.remove(id)
                            } else {
                                selectedIds.insert(id)
                            }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.collection.localizedTitle ?? "Unbekannt")
                                        .foregroundStyle(.primary)
                                    Text("\(item.count) Foto\(item.count == 1 ? "" : "s")")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if selectedIds.contains(item.collection.localIdentifier) {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(Color.accentColor)
                                        .fontWeight(.semibold)
                                }
                            }
                        }
                    }
                }
            }
            .listStyle(.plain)
        }
        .navigationTitle("Alben auswählen")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            albums = await loadAlbums()
            isLoading = false
        }
    }

    private func loadAlbums() async -> [(collection: PHAssetCollection, count: Int)] {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else { return [] }

        return await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                var result: [(PHAssetCollection, Int)] = []
                var seenIds = Set<String>()
                var seenNames = Set<String>()
                PHAssetCollection
                    .fetchAssetCollections(with: .album, subtype: .any, options: nil)
                    .enumerateObjects { collection, _, _ in
                        guard seenIds.insert(collection.localIdentifier).inserted else { return }
                        let name = collection.localizedTitle ?? ""
                        guard seenNames.insert(name.lowercased()).inserted else { return }
                        let count = PHAsset.fetchAssets(in: collection, options: nil).count
                        if count > 0 { result.append((collection, count)) }
                    }
                continuation.resume(returning: result.sorted { ($0.0.localizedTitle ?? "") < ($1.0.localizedTitle ?? "") })
            }
        }
    }
}
