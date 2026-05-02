import SwiftUI
import Photos

struct DownloadSettingsView: View {
    @AppStorage("download.enabled")  private var downloadEnabled = false
    @AppStorage("download.wifiOnly") private var wifiOnly        = true

    @State private var selectedAlbumIds: Set<Int> = DownloadSyncPreferences.selectedServerAlbumIds
    @State private var favoritesFilter: DownloadFavoritesFilter = DownloadSyncPreferences.favoritesFilter
    @State private var includeHidden: Bool = DownloadSyncPreferences.includeHidden
    @State private var serverAlbums: [Album] = []
    @State private var isSyncing    = false
    @State private var syncError: String?
    @State private var refreshTick  = 0
    @State private var showResetConfirm = false
    @State private var showAuthAlert    = false
    @State private var showAlbumPicker  = false

    private var lastDownloadDate: Date? { DownloadSyncPreferences.lastDownloadDate }
    private var downloadedCount: Int    { DownloadSyncPreferences.downloadedCount }

    var body: some View {
        Form {
            // ── Master toggle ──────────────────────────────────────────
            Section {
                Toggle("Automatisch herunterladen", isOn: $downloadEnabled)
            } footer: {
                Text("Server-Alben werden automatisch im Hintergrund auf das Gerät synchronisiert.")
            }

            if downloadEnabled {
                // ── Album selection ────────────────────────────────────
                Section {
                    NavigationLink {
                        DownloadAlbumPickerView(
                            serverAlbums: serverAlbums,
                            selectedIds: $selectedAlbumIds
                        )
                        .onChange(of: selectedAlbumIds) { _, newValue in
                            DownloadSyncPreferences.selectedServerAlbumIds = newValue
                        }
                    } label: {
                        HStack {
                            Text("Server-Alben")
                            Spacer()
                            Text(selectedAlbumIds.isEmpty
                                 ? "Keine gewählt"
                                 : "\(selectedAlbumIds.count) gewählt")
                                .foregroundStyle(.secondary)
                        }
                    }
                } header: {
                    Text("Alben")
                } footer: {
                    Text("Wähle die Server-Alben aus, die auf dieses Gerät heruntergeladen werden sollen. Der iOS-Albumname entspricht dem Server-Albumnamen.")
                }

                // ── Filter ─────────────────────────────────────────────
                Section {
                    Picker("Favoriten", selection: $favoritesFilter) {
                        ForEach(DownloadFavoritesFilter.allCases, id: \.self) { f in
                            Text(f.label).tag(f)
                        }
                    }
                    .pickerStyle(.menu)
                    .onChange(of: favoritesFilter) { _, newValue in
                        DownloadSyncPreferences.favoritesFilter = newValue
                    }

                    Toggle("Ausgeblendete einschliessen", isOn: $includeHidden)
                        .onChange(of: includeHidden) { _, newValue in
                            DownloadSyncPreferences.includeHidden = newValue
                        }
                } header: {
                    Text("Filter")
                } footer: {
                    Text("Legt fest, welche Fotos aus dem Server-Album heruntergeladen werden. Favoriten-Status und Beschreibung werden beim Download übernommen.")
                }

                // ── Network ────────────────────────────────────────────
                Section {
                    Toggle("Nur WLAN", isOn: $wifiOnly)
                } header: {
                    Text("Netzwerk")
                } footer: {
                    Text("Wenn aktiviert, werden Fotos nur über WLAN heruntergeladen.")
                }

                // ── Manual trigger ─────────────────────────────────────
                Section {
                    Button {
                        syncError = nil
                        isSyncing = true
                        Task {
                            do {
                                try await PhotoDownloadService.shared.sync()
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
                            if isSyncing { ProgressView() }
                        }
                    }
                    .disabled(isSyncing || selectedAlbumIds.isEmpty)

                    if let error = syncError {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }

            // ── Status ─────────────────────────────────────────────────
            Section("Status") {
                LabeledContent("Letzter Download") {
                    if let date = lastDownloadDate {
                        Text(date, style: .relative)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("Noch nie")
                            .foregroundStyle(.secondary)
                    }
                }
                LabeledContent("Heruntergeladene Fotos") {
                    Text("\(downloadedCount)")
                        .foregroundStyle(.secondary)
                }
                Button(role: .destructive) {
                    showResetConfirm = true
                } label: {
                    Text("Download-Verlauf zurücksetzen")
                }
            }
            .id(refreshTick)
            .confirmationDialog(
                "Download-Verlauf zurücksetzen?",
                isPresented: $showResetConfirm,
                titleVisibility: .visible
            ) {
                Button("Zurücksetzen", role: .destructive) {
                    DownloadSyncPreferences.resetDownloadHistory()
                    refreshTick += 1
                }
                Button("Abbrechen", role: .cancel) {}
            } message: {
                Text("Alle Fotos werden beim nächsten Sync erneut heruntergeladen.")
            }
        }
        .navigationTitle("Automatisch herunterladen")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            selectedAlbumIds   = DownloadSyncPreferences.selectedServerAlbumIds
            favoritesFilter    = DownloadSyncPreferences.favoritesFilter
            includeHidden      = DownloadSyncPreferences.includeHidden
            refreshTick       += 1
        }
        .task { await loadServerAlbums() }
        .alert("Zugriff verweigert", isPresented: $showAuthAlert) {
            Button("Einstellungen öffnen") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
            Button("Abbrechen", role: .cancel) {
                downloadEnabled = false
            }
        } message: {
            Text("Bitte erlaube den Lese- und Schreibzugriff auf Fotos in den App-Einstellungen.")
        }
        .onChange(of: downloadEnabled) { _, enabled in
            if enabled {
                Task {
                    let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
                    await MainActor.run {
                        if status == .denied || status == .restricted {
                            downloadEnabled = false
                            showAuthAlert   = true
                        } else {
                            BackgroundSyncManager.shared.scheduleNextSyncIfNeeded()
                        }
                    }
                }
            } else {
                BackgroundSyncManager.shared.scheduleNextSyncIfNeeded()
            }
        }
    }

    private func loadServerAlbums() async {
        do {
            let response: ListAlbumsResponse = try await APIClient.shared.get("/albums")
            serverAlbums = response.albums.sorted {
                $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
        } catch {}
    }
}

// MARK: - Download Album Picker (multi-select server albums)

struct DownloadAlbumPickerView: View {
    let serverAlbums: [Album]
    @Binding var selectedIds: Set<Int>

    @State private var searchText = ""

    private var filteredAlbums: [Album] {
        guard !searchText.isEmpty else { return serverAlbums }
        return serverAlbums.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
    }

    var body: some View {
        List {
            if serverAlbums.isEmpty {
                ContentUnavailableView {
                    Label("Keine Alben", systemImage: "rectangle.stack")
                } description: {
                    Text("Es wurden keine Server-Alben gefunden.")
                }
            } else if filteredAlbums.isEmpty {
                ContentUnavailableView {
                    Label("Keine Treffer", systemImage: "magnifyingglass")
                } description: {
                    Text("Kein Album entspricht \"\(searchText)\".")
                }
            } else {
                ForEach(filteredAlbums) { album in
                    Button {
                        if selectedIds.contains(album.id) {
                            selectedIds.remove(album.id)
                        } else {
                            selectedIds.insert(album.id)
                        }
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(album.name)
                                    .foregroundStyle(.primary)
                                Text("\(album.photo_count) Foto\(album.photo_count == 1 ? "" : "s")")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if selectedIds.contains(album.id) {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(Color.accentColor)
                                    .fontWeight(.semibold)
                            }
                        }
                    }
                }
            }
        }
        .searchable(text: $searchText, prompt: "Album suchen")
        .navigationTitle("Server-Alben")
        .navigationBarTitleDisplayMode(.inline)
    }
}
