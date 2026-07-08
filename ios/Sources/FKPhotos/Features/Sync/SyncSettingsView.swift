import SwiftUI
import Photos

struct SyncSettingsView: View {
    @AppStorage("sync.enabled")            private var syncEnabled        = false
    @AppStorage("sync.wifiOnly")           private var wifiOnly           = true
    @AppStorage("sync.excludeScreenshots") private var excludeScreenshots = true

    @State private var selectedAlbumIds: Set<String> = PhotoSyncPreferences.selectedAlbumIds
    @State private var albumServerMappings: [String: Int] = PhotoSyncPreferences.albumMappings
    @State private var serverAlbums: [Album] = []
    @State private var iosAlbumNames: [String: String] = [:]
    @State private var iosAlbumAssetCounts: [String: Int] = [:]
    @State private var showAuthAlert = false
    @State private var refreshTick   = 0  // Bump to re-read status values
    @State private var showResetConfirm = false
    @State private var isSyncing     = false
    @State private var syncError: String?
    @State private var queueObserver = UploadQueueObserver()
    @State private var progress = SyncProgress.shared
    /// Newly added iOS albums waiting for the user's "Alle Fotos hochladen"
    /// vs. "Nur neue ab jetzt" decision (issue: previously the watermark was
    /// set to NOW unconditionally, so users never got a full first-time sync
    /// without manually swiping-to-reset on every album). One album is shown
    /// at a time in the confirmation dialog; the rest queue up here.
    @State private var pendingInitialSyncQueue: [PendingInitialSync] = []
    /// The album currently shown in the confirmation dialog, if any. Driving
    /// the dialog off an Optional (rather than `!queue.isEmpty`) lets SwiftUI
    /// correctly re-present the dialog for each subsequent album.
    @State private var currentInitialSync: PendingInitialSync? = nil

    struct PendingInitialSync: Identifiable, Equatable {
        let id: String  // iOS album localIdentifier
        let displayName: String
        let assetCount: Int
    }

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
                    NavigationLink {
                        AlbumPickerView(selectedIds: $selectedAlbumIds)
                            .onChange(of: selectedAlbumIds) { oldValue, newValue in
                                PhotoSyncPreferences.selectedAlbumIds = newValue
                                let added = newValue.subtracting(oldValue)
                                if !added.isEmpty {
                                    // "Gesamte Mediathek" is auto-confirmed
                                    if added.contains(PhotoSyncPreferences.allLibrarySentinel) {
                                        PhotoSyncPreferences.confirmMapping(for: PhotoSyncPreferences.allLibrarySentinel)
                                    }
                                    enqueueInitialSyncDecisions(for: added)
                                }
                                let deselected = oldValue.subtracting(newValue)
                                for id in deselected {
                                    PhotoSyncPreferences.unconfirmMapping(for: id)
                                }
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
                } header: {
                    Text("Fotos")
                }

                // ── Per-album server mapping ──────────────────────────
                if !selectedAlbumIds.isEmpty {
                    Section {
                        ForEach(sortedSelectedAlbumIds, id: \.self) { iosId in
                            let isConfirmed = PhotoSyncPreferences.isMappingConfirmed(for: iosId)
                            NavigationLink {
                                ServerAlbumPickerView(
                                    title: displayName(for: iosId),
                                    selectedAlbumId: serverAlbumBinding(for: iosId),
                                    disabledIds: cycleDisabledIds(forIosAlbum: iosId),
                                    onAlbumCreated: { album in
                                        if !serverAlbums.contains(where: { $0.id == album.id }) {
                                            serverAlbums.append(album)
                                        }
                                    }
                                )
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack {
                                        if !isConfirmed {
                                            Image(systemName: "exclamationmark.triangle.fill")
                                                .foregroundStyle(.orange)
                                                .font(.caption)
                                        }
                                        Text(displayName(for: iosId))
                                        Spacer()
                                        if isConfirmed {
                                            Text(serverAlbumName(for: albumServerMappings[iosId]) ?? "Kein Album")
                                                .foregroundStyle(albumServerMappings[iosId] != nil ? .secondary : .tertiary)
                                        } else {
                                            Text("Nicht zugeordnet")
                                                .foregroundStyle(.orange)
                                        }
                                    }
                                    if !isConfirmed {
                                        Text("Bitte Ziel-Album wählen – wird sonst nicht synchronisiert")
                                            .font(.caption)
                                            .foregroundStyle(.orange)
                                    } else if let syncDate = PhotoSyncPreferences.albumSyncDate(for: iosId) {
                                        Text("Letzter Sync: \(syncDate, style: .relative)")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    } else {
                                        Text("Noch nicht synchronisiert")
                                            .font(.caption)
                                            .foregroundStyle(.tertiary)
                                    }
                                }
                            }
                            .swipeActions(edge: .trailing) {
                                if PhotoSyncPreferences.albumSyncDate(for: iosId) != nil {
                                    Button {
                                        PhotoSyncPreferences.resetAlbumSyncDate(for: iosId)
                                        refreshTick += 1
                                    } label: {
                                        Label("Erneut syncen", systemImage: "arrow.counterclockwise")
                                    }
                                    .tint(.orange)
                                }
                            }
                            .swipeActions(edge: .leading) {
                                Button {
                                    PhotoSyncPreferences.setAlbumSyncDate(Date(), for: iosId)
                                    refreshTick += 1
                                } label: {
                                    Label("Nur neue Fotos", systemImage: "clock.arrow.trianglehead.counterclockwise.rotate.90")
                                }
                                .tint(.blue)
                            }

                            // Per-album sync mode — only for a confirmed album
                            // mapped to a real target (not the whole-library
                            // sentinel, where deletion mirroring makes no sense).
                            if isConfirmed,
                               albumServerMappings[iosId] != nil,
                               iosId != PhotoSyncPreferences.allLibrarySentinel {
                                Picker("Modus", selection: modeBinding(for: iosId)) {
                                    Text("Kopieren").tag(PhotoSyncMode.copy)
                                    Text("Synchronisieren").tag(PhotoSyncMode.sync)
                                    Text("Zwei-Wege").tag(PhotoSyncMode.bisync)
                                }
                                .pickerStyle(.menu)
                            }
                        }
                    } header: {
                        Text("Album Zuordnungen")
                    } footer: {
                        Text("Modus **Kopieren**: Fotos werden nur hochgeladen. Modus **Synchronisieren**: aus dem iOS-Album gelöschte Fotos werden auch aus dem Server-Album entfernt. Modus **Zwei-Wege**: zusätzlich werden neue Server-Fotos aufs Gerät geladen und Server-Löschungen übernommen.\n\nNach links wischen → alle Fotos erneut synchronisieren. Nach rechts wischen → nur zukünftige Fotos synchronisieren.")
                    }
                }

                // ── Manual trigger ─────────────────────────────────────
                Section {
                    Button {
                        syncError = nil
                        isSyncing = true
                        Task {
                            // Surface why the tap does nothing instead of a
                            // silent no-op when the WiFi-only gate blocks it.
                            guard await BackgroundSyncManager.networkAllowsUpload() else {
                                syncError = PhotoSyncPreferences.wifiOnly
                                    ? "Kein WLAN verfügbar. „Nur WLAN“ ist aktiv – verbinde dich mit einem WLAN oder deaktiviere die Einstellung."
                                    : "Keine Netzwerkverbindung verfügbar."
                                isSyncing = false
                                return
                            }
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
                            if isSyncing || progress.isActive {
                                ProgressView()
                            }
                        }
                    }
                    .buttonStyle(.borderless)
                    .disabled(isSyncing || progress.isActive)

                    if progress.isActive, !progress.label.isEmpty {
                        Text(progress.label)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    if let error = syncError {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }

            // ── Media types (always visible — also applies to manual uploads) ──
            Section {
                Toggle("Screenshots ausschliessen", isOn: $excludeScreenshots)
                HStack {
                    Text("Videos")
                    Spacer()
                    Text("Noch nicht unterstützt")
                        .font(.footnote)
                        .foregroundStyle(.tertiary)
                }
            } header: {
                Text("Medientypen")
            } footer: {
                Text("Screenshots werden standardmässig nicht hochgeladen. Video-Upload wird in einer zukünftigen Version unterstützt.")
            }

            // ── Network (always visible — also applies to manual uploads) ──
            Section {
                Toggle("Nur WLAN", isOn: $wifiOnly)
            } header: {
                Text("Netzwerk")
            } footer: {
                Text("Wenn aktiviert, werden Fotos nur über WLAN hochgeladen.")
            }

            // ── Debug ──────────────────────────────────────────────────
            #if DEBUG
            Section("Debug") {
                Button("Hintergrund-Task einplanen") {
                    BackgroundSyncManager.shared.scheduleNextSyncIfNeeded()
                }
                .foregroundStyle(Color.accentColor)
            }
            #endif

            // ── Upload queue ──────────────────────────────────────────
            if queueObserver.hasVisibleItems {
                Section {
                    NavigationLink {
                        UploadQueueDetailView(observer: queueObserver)
                    } label: {
                        HStack(spacing: 12) {
                            if !queueObserver.failedItems.isEmpty {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .foregroundStyle(.red)
                            } else {
                                Image(systemName: "arrow.up.circle")
                                    .foregroundStyle(.orange)
                            }
                            VStack(alignment: .leading, spacing: 2) {
                                if !queueObserver.pendingItems.isEmpty {
                                    Text("\(queueObserver.pendingItems.count) ausstehend")
                                        .font(.subheadline)
                                }
                                if !queueObserver.failedItems.isEmpty {
                                    Text("\(queueObserver.failedItems.count) fehlgeschlagen")
                                        .font(.subheadline)
                                        .foregroundStyle(.red)
                                }
                            }
                        }
                    }
                } header: {
                    Text("Upload-Warteschlange")
                }
            }

            // ── Status ─────────────────────────────────────────────────
            Section {
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
            } header: {
                Text("Status")
            } footer: {
                Text("Beim Zurücksetzen werden alle Fotos beim nächsten Sync erneut mit dem Server abgeglichen. Bereits hochgeladene Fotos werden nicht doppelt angelegt.")
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
            refreshTick += 1
            queueObserver.startObserving()
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
        .onChange(of: wifiOnly) { _, wifiRequired in
            if !wifiRequired {
                Task { await BackgroundSyncManager.shared.drainUploadQueue() }
            }
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
        .confirmationDialog(
            initialSyncDialogTitle,
            isPresented: Binding(
                get: { currentInitialSync != nil },
                // SwiftUI auto-sets this to false after any button tap or
                // swipe-down dismiss. Whichever way it happens, advance to
                // the next pending album (or clear the dialog).
                set: { isShown in if !isShown { advanceInitialSyncDialog() } }
            ),
            titleVisibility: .visible,
            presenting: currentInitialSync
        ) { item in
            Button("Alle Fotos hochladen") {
                // Just record the decision; the binding's `set(false)` from
                // SwiftUI's auto-dismiss is what advances to the next album.
                PhotoSyncPreferences.resetAlbumSyncDate(for: item.id)
            }
            Button("Nur neue ab jetzt") {
                // No-op: the watermark is already pre-set to NOW.
            }
            Button("Abbrechen", role: .cancel) {
                // Same as "Nur neue ab jetzt" — keep the safe default.
            }
        } message: { item in
            Text(initialSyncDialogMessage(for: item))
        }
    }

    // MARK: - Helpers

    /// Returns server album IDs that would create an upload→download cycle for the given iOS album.
    /// A cycle occurs when the server album has the same name as the iOS album and is also selected
    /// for download — downloaded photos would land in the same iOS album and be re-uploaded.
    private func cycleDisabledIds(forIosAlbum iosId: String) -> Set<Int> {
        let iosName = iosAlbumNames[iosId] ?? ""
        guard !iosName.isEmpty else { return [] }
        let downloadIds = DownloadSyncPreferences.selectedServerAlbumIds
        return Set(serverAlbums.filter { $0.name == iosName && downloadIds.contains($0.id) }.map { $0.id })
    }

    private var sortedSelectedAlbumIds: [String] {
        // "Gesamte Mediathek" sentinel always sorts to the top.
        Array(selectedAlbumIds).sorted { id1, id2 in
            if id1 == PhotoSyncPreferences.allLibrarySentinel { return true }
            if id2 == PhotoSyncPreferences.allLibrarySentinel { return false }
            return displayName(for: id1) < displayName(for: id2)
        }
    }

    /// The visible label for a selected album row. Uses the iOS album title
    /// when known, falls back to the localIdentifier, and special-cases the
    /// "all library" sentinel.
    private func displayName(for iosId: String) -> String {
        if iosId == PhotoSyncPreferences.allLibrarySentinel {
            return "Gesamte Mediathek"
        }
        return iosAlbumNames[iosId] ?? iosId
    }

    // MARK: - Initial-sync decision

    /// Captures the per-album choice and switches the watermark accordingly.
    ///
    /// We pre-set the watermark to NOW (the safe "nur neue" default) so any
    /// path that bypasses the dialog — user dismisses it, or the app exits
    /// before deciding — doesn't accidentally trigger a full-library upload.
    /// The user explicitly choosing "Alle Fotos hochladen" then clears the
    /// watermark to enumerate the full history.
    private func enqueueInitialSyncDecisions(for ids: Set<String>) {
        let now = Date()
        for id in ids {
            PhotoSyncPreferences.setAlbumSyncDate(now, for: id)
        }
        Task {
            // Pre-fetch counts so the dialog can tell the user how many photos
            // a "full sync" would actually mean.
            await loadIosAlbumNames()
            let pending = ids.map { id in
                PendingInitialSync(
                    id: id,
                    displayName: displayName(for: id),
                    assetCount: iosAlbumAssetCounts[id] ?? 0
                )
            }
            await MainActor.run {
                pendingInitialSyncQueue.append(contentsOf: pending)
                if currentInitialSync == nil {
                    advanceInitialSyncDialog()
                }
            }
        }
    }

    private var initialSyncDialogTitle: String {
        guard let item = currentInitialSync else { return "" }
        return "Album \"\(item.displayName)\""
    }

    private func initialSyncDialogMessage(for item: PendingInitialSync) -> String {
        if item.id == PhotoSyncPreferences.allLibrarySentinel {
            return "Sollen alle Fotos der Mediathek hochgeladen werden oder nur neue ab jetzt?"
        }
        if item.assetCount > 0 {
            return "Sollen alle \(item.assetCount) Fotos dieses Albums hochgeladen werden oder nur neue ab jetzt?"
        }
        return "Sollen alle bisherigen Fotos hochgeladen werden oder nur neue ab jetzt?"
    }

    /// Pops the next pending album into `currentInitialSync`, or sets it nil
    /// when the queue is drained. The dialog binding observes the Optional.
    private func advanceInitialSyncDialog() {
        if pendingInitialSyncQueue.isEmpty {
            currentInitialSync = nil
        } else {
            currentInitialSync = pendingInitialSyncQueue.removeFirst()
        }
    }

    private func serverAlbumName(for albumId: Int?) -> String? {
        guard let albumId else { return nil }
        return serverAlbums.first { $0.id == albumId }?.name
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
                PhotoSyncPreferences.confirmMapping(for: iosId)
                refreshTick += 1
                Task { await loadServerAlbums() }
            }
        )
    }

    /// Reads/writes the per-album sync mode. Switching to sync schedules a run
    /// so the deletion pass reconciles the server album against the current iOS
    /// album contents.
    private func modeBinding(for iosId: String) -> Binding<PhotoSyncMode> {
        Binding(
            get: { PhotoSyncPreferences.albumSyncMode(for: iosId) },
            set: { newMode in
                PhotoSyncPreferences.setAlbumSyncMode(newMode, for: iosId)
                if newMode == .sync {
                    BackgroundSyncManager.shared.scheduleNextSyncIfNeeded()
                }
                refreshTick += 1
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
        let ids = Array(selectedAlbumIds).filter { $0 != PhotoSyncPreferences.allLibrarySentinel }
        let needsSentinelCount = selectedAlbumIds.contains(PhotoSyncPreferences.allLibrarySentinel)

        let loaded: (names: [String: String], counts: [String: Int]) = await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                var names: [String: String] = [:]
                var counts: [String: Int] = [:]
                let imageFilter = PHFetchOptions()
                imageFilter.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)

                if !ids.isEmpty {
                    PHAssetCollection
                        .fetchAssetCollections(withLocalIdentifiers: ids, options: nil)
                        .enumerateObjects { collection, _, _ in
                            if let title = collection.localizedTitle {
                                names[collection.localIdentifier] = title
                            }
                            counts[collection.localIdentifier] = PHAsset.fetchAssets(in: collection, options: imageFilter).count
                        }
                }
                if needsSentinelCount {
                    counts[PhotoSyncPreferences.allLibrarySentinel] = PHAsset.fetchAssets(with: .image, options: nil).count
                }
                continuation.resume(returning: (names, counts))
            }
        }
        iosAlbumNames = loaded.names
        iosAlbumAssetCounts = loaded.counts
    }
}

// MARK: - Album Picker

struct AlbumPickerView: View {
    @Binding var selectedIds: Set<String>

    /// One row in the picker. `id` is the sentinel for the synthetic "all
    /// library" entry; otherwise it equals `collection.localIdentifier`.
    struct PickerEntry: Identifiable, Equatable {
        let id: String
        let collection: PHAssetCollection?  // nil for the all-library row
        let title: String
        let count: Int
        /// Disambiguates name collisions in the UI (e.g. "Aufnahmen (Smart)").
        let suffix: String?
        /// True for a still-selected album that no longer exists in the photo
        /// library (deleted in iOS). Surfaced only so the user can untick it —
        /// otherwise the dangling selection (and its server mapping/watermark)
        /// would be stuck forever, since deleted albums never appear in a fetch.
        var isMissing: Bool = false
        var displayTitle: String {
            suffix.map { "\(title) (\($0))" } ?? title
        }
        static func == (lhs: PickerEntry, rhs: PickerEntry) -> Bool { lhs.id == rhs.id }
    }

    @State private var entries: [PickerEntry] = []
    @State private var isLoading = true
    @State private var searchText = ""

    private var filteredEntries: [PickerEntry] {
        let base = searchText.isEmpty
            ? entries
            : entries.filter { $0.displayTitle.localizedCaseInsensitiveContains(searchText) }
        return base.sorted { a, b in
            // Selected first; then the all-library sentinel; then alphabetical.
            let aSelected = selectedIds.contains(a.id)
            let bSelected = selectedIds.contains(b.id)
            if aSelected != bSelected { return aSelected }
            if a.collection == nil { return true }
            if b.collection == nil { return false }
            return a.displayTitle.localizedCaseInsensitiveCompare(b.displayTitle) == .orderedAscending
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
                } else if entries.isEmpty {
                    ContentUnavailableView {
                        Label("Keine Alben", systemImage: "photo.on.rectangle.angled")
                    } description: {
                        Text("Es wurden keine Alben mit Fotos gefunden.")
                    }
                } else if filteredEntries.isEmpty {
                    ContentUnavailableView {
                        Label("Keine Treffer", systemImage: "magnifyingglass")
                    } description: {
                        Text("Kein Album entspricht \"\(searchText)\".")
                    }
                } else {
                    ForEach(filteredEntries) { entry in
                        Button {
                            toggle(entry)
                        } label: {
                            HStack {
                                if entry.isMissing {
                                    Image(systemName: "exclamationmark.triangle")
                                        .foregroundStyle(.orange)
                                } else if entry.collection == nil {
                                    Image(systemName: "photo.stack")
                                        .foregroundStyle(Color.accentColor)
                                }
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(entry.displayTitle)
                                        .foregroundStyle(entry.isMissing ? .secondary : .primary)
                                    if entry.isMissing {
                                        Text("Nicht mehr vorhanden – tippen zum Entfernen")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    } else {
                                        Text("\(entry.count) Foto\(entry.count == 1 ? "" : "s")")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                if selectedIds.contains(entry.id) {
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
            entries = await loadEntries()
            isLoading = false
        }
    }

    /// Picking the "Gesamte Mediathek" sentinel is mutually exclusive with
    /// regular album selection — otherwise the same asset would be enumerated
    /// twice (once via collection, once via the full-library path), and the
    /// per-album watermark for "all" would race with per-album watermarks.
    private func toggle(_ entry: PickerEntry) {
        if entry.id == PhotoSyncPreferences.allLibrarySentinel {
            if selectedIds.contains(entry.id) {
                selectedIds.remove(entry.id)
            } else {
                selectedIds = [entry.id]
            }
            return
        }
        if selectedIds.contains(entry.id) {
            selectedIds.remove(entry.id)
        } else {
            // Selecting any regular album cancels the all-library sentinel.
            selectedIds.remove(PhotoSyncPreferences.allLibrarySentinel)
            selectedIds.insert(entry.id)
        }
    }

    private func loadEntries() async -> [PickerEntry] {
        var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .notDetermined {
            status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        }
        guard status == .authorized || status == .limited else { return [] }

        // Snapshot the current selection so the background fetch can spot ids
        // that no longer resolve to a live collection (deleted in iOS).
        let selectedSnapshot = selectedIds

        return await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                // Synthetic top row for the "upload everything, sort it out on
                // the server" workflow. Count is the full library size.
                let imageFilter = PHFetchOptions()
                imageFilter.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
                let libraryCount = PHAsset.fetchAssets(with: .image, options: nil).count

                var result: [PickerEntry] = [
                    PickerEntry(
                        id: PhotoSyncPreferences.allLibrarySentinel,
                        collection: nil,
                        title: "Gesamte Mediathek",
                        count: libraryCount,
                        suffix: nil
                    )
                ]
                var seenIds = Set<String>()

                // Subtypes that show up in the user's picker as semantic
                // duplicates of regular albums or as content the user almost
                // never wants to sync as a unit. The list is intentionally
                // generous — the user can still pick "Gesamte Mediathek" to
                // capture everything.
                let skipSubtypes: Set<PHAssetCollectionSubtype> = [
                    .smartAlbumVideos, .smartAlbumAllHidden, .smartAlbumSlomoVideos,
                    .smartAlbumTimelapses, .smartAlbumAnimated,
                    .smartAlbumGeneric, .smartAlbumSelfPortraits,
                    .smartAlbumLongExposures, .smartAlbumDepthEffect,
                    .smartAlbumLivePhotos, .smartAlbumBursts,
                    .smartAlbumScreenshots, .smartAlbumPanoramas,
                ]

                // Collect smart + user albums into a flat list, tagged with
                // their origin so we can suffix-disambiguate name collisions.
                struct RawAlbum {
                    let collection: PHAssetCollection
                    let title: String
                    let count: Int
                    let isSmart: Bool
                }
                var raw: [RawAlbum] = []
                func collect(from fetchResult: PHFetchResult<PHAssetCollection>, isSmart: Bool) {
                    fetchResult.enumerateObjects { collection, _, _ in
                        if skipSubtypes.contains(collection.assetCollectionSubtype) { return }
                        guard seenIds.insert(collection.localIdentifier).inserted else { return }
                        let count = PHAsset.fetchAssets(in: collection, options: imageFilter).count
                        guard count > 0 else { return }
                        let title = collection.localizedTitle ?? "Unbekannt"
                        raw.append(RawAlbum(collection: collection, title: title, count: count, isSmart: isSmart))
                    }
                }
                collect(from: PHAssetCollection.fetchAssetCollections(with: .smartAlbum, subtype: .any, options: nil), isSmart: true)
                collect(from: PHAssetCollection.fetchAssetCollections(with: .album, subtype: .albumRegular, options: nil), isSmart: false)

                // Build a name-occurrence map so we only suffix-disambiguate
                // when there's an actual collision. A unique title stays
                // untouched.
                var titleCounts: [String: Int] = [:]
                for r in raw { titleCounts[r.title.lowercased(), default: 0] += 1 }

                for r in raw {
                    let needsSuffix = (titleCounts[r.title.lowercased()] ?? 0) > 1
                    let suffix: String? = needsSuffix ? (r.isSmart ? "Smart" : "Eigenes") : nil
                    result.append(PickerEntry(
                        id: r.collection.localIdentifier,
                        collection: r.collection,
                        title: r.title,
                        count: r.count,
                        suffix: suffix
                    ))
                }

                // Still-selected albums that didn't show up in any fetch were
                // deleted in iOS. Add a removable "deleted album" row for each so
                // the user can untick the stuck selection (the sentinel is never
                // an orphan — it isn't a real collection).
                let orphanIds = selectedSnapshot
                    .subtracting(seenIds)
                    .subtracting([PhotoSyncPreferences.allLibrarySentinel])
                for orphanId in orphanIds.sorted() {
                    result.append(PickerEntry(
                        id: orphanId,
                        collection: nil,
                        title: "Gelöschtes Album",
                        count: 0,
                        suffix: nil,
                        isMissing: true
                    ))
                }

                continuation.resume(returning: result)
            }
        }
    }
}

// MARK: - Upload Queue Detail

struct UploadQueueDetailView: View {
    @Bindable var observer: UploadQueueObserver

    var body: some View {
        List {
            if !observer.pendingItems.isEmpty {
                Section {
                    ForEach(observer.pendingItems) { item in
                        HStack(spacing: 12) {
                            Image(systemName: "arrow.up.circle")
                                .foregroundStyle(.orange)
                            Text(item.filename)
                                .font(.subheadline)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                } header: {
                    HStack {
                        Text("Ausstehend (\(observer.pendingItems.count))")
                        Spacer()
                        Button("Abbrechen") {
                            observer.cancelPending()
                        }
                        .font(.caption)
                        .foregroundStyle(.red)
                    }
                }
            }

            if !observer.failedItems.isEmpty {
                Section {
                    ForEach(observer.failedItems) { item in
                        HStack(spacing: 12) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(.red)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.filename)
                                    .font(.subheadline)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                if let error = item.lastError {
                                    Text(error)
                                        .font(.caption)
                                        .foregroundStyle(.red)
                                        .lineLimit(2)
                                }
                                Text("Fehlgeschlagen\(item.retryCount > 1 ? " (\(item.retryCount)×)" : "")")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            Button(role: .destructive) {
                                observer.remove(id: item.id)
                            } label: {
                                Label("Löschen", systemImage: "trash")
                            }
                        }
                    }
                } header: {
                    HStack {
                        Text("Fehlgeschlagen (\(observer.failedItems.count))")
                        Spacer()
                        Button {
                            observer.requeueAllFailed()
                        } label: {
                            Text("Alle erneut")
                                .font(.caption)
                        }
                        Button(role: .destructive) {
                            observer.removeAllFailed()
                        } label: {
                            Text("Alle löschen")
                                .font(.caption)
                        }
                    }
                }
            }

            if observer.pendingItems.isEmpty && observer.failedItems.isEmpty {
                ContentUnavailableView {
                    Label("Keine Einträge", systemImage: "checkmark.circle")
                } description: {
                    Text("Die Upload-Warteschlange ist leer.")
                }
                .listRowSeparator(.hidden)
            }
        }
        .navigationTitle("Upload-Warteschlange")
        .navigationBarTitleDisplayMode(.inline)
    }
}
