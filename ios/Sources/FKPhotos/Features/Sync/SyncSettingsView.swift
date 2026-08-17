import SwiftUI
import Photos

/// Global control panel for the automatic photo sync. Which albums sync — and
/// in which mode (copy / sync / bisync) — is configured per album in the iOS
/// media library via "Mit f4mil verknüpfen…"; this screen only holds the master
/// switch, global options, status and the manual trigger.
struct SyncSettingsView: View {
    @AppStorage("sync.enabled")            private var syncEnabled        = false
    @AppStorage("sync.wifiOnly")           private var wifiOnly           = true
    @AppStorage("sync.excludeScreenshots") private var excludeScreenshots = true
    // Mirrors `TripSuggestionSettings.enabled` — same key, same default, so the
    // toggle and the monitors that read it can never disagree.
    @AppStorage("trip.suggestions.enabled") private var tripSuggestions = true

    @State private var showAuthAlert = false
    @State private var refreshTick   = 0  // Bump to re-read status values
    @State private var showResetConfirm = false
    @State private var isSyncing     = false
    @State private var syncError: String?
    @State private var queueObserver = UploadQueueObserver()
    @State private var progress = SyncProgress.shared

    private var lastSyncDate:   Date? { PhotoSyncPreferences.lastSyncDate }
    private var uploadedCount:  Int   { PhotoSyncPreferences.uploadedCount }
    /// Re-read via `refreshTick` so the row disappears right after resetting.
    private var suppressedRegionCount: Int {
        _ = refreshTick
        return TripRegionSuppression.suppressedRegions.count
    }

    var body: some View {
        Form {
            // ── Master toggle ──────────────────────────────────────────
            Section {
                Toggle("Automatisch synchronisieren", isOn: $syncEnabled)
            } footer: {
                Text("Verknüpfte Alben werden automatisch im Hintergrund synchronisiert. Welche Alben – und ob Kopieren, Synchronisieren oder Zwei-Wege – legst du in der iOS-Mediathek über „\(SyncWording.linkFromLibrary)“ fest.")
            }

            // ── Manual trigger ─────────────────────────────────────────
            if syncEnabled {
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
                                // Full pipeline (upload + download/bisync), not
                                // just the upload half — otherwise a manual sync
                                // never pulls server-side album additions down.
                                try await BackgroundSyncManager.shared.runFullSync()
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
                Text("Wenn aktiviert, wird nur über WLAN synchronisiert.")
            }

            // ── Trip suggestions (docs/ios-trip-mode.md §9.3) ──────────
            Section {
                Toggle("Trip-Vorschläge", isOn: $tripSuggestions)
                if tripSuggestions, suppressedRegionCount > 0 {
                    Button("Ausgeblendete Orte zurücksetzen (\(suppressedRegionCount))") {
                        TripRegionSuppression.resetAll()
                        refreshTick += 1
                    }
                    .foregroundStyle(Color.accentColor)
                }
            } header: {
                Text("Trip")
            } footer: {
                Text("F4mil Photos schlägt vor, Trip Mode einzuschalten, wenn deine Fotos zeigen, dass du weit weg von zuhause bist – und vor, ihn zu beenden, wenn du wieder da bist. Vorgeschlagen wird nur; gestartet und beendet wird nie automatisch. Orte, die du oft besuchst, werden mit der Zeit von selbst nicht mehr vorgeschlagen.")
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
                LabeledContent("Letzte Synchronisierung") {
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
                    Text("Sync-Verlauf zurücksetzen")
                }
            } header: {
                Text("Status")
            } footer: {
                Text("Beim Zurücksetzen werden alle Fotos beim nächsten Sync erneut mit dem Server abgeglichen. Bereits hochgeladene Fotos werden nicht doppelt angelegt.")
            }
            .id(refreshTick)  // Force re-render when tick changes
            .confirmationDialog(
                "Sync-Verlauf zurücksetzen?",
                isPresented: $showResetConfirm,
                titleVisibility: .visible
            ) {
                Button("Zurücksetzen", role: .destructive) {
                    PhotoSyncPreferences.resetUploadHistory()
                    DownloadSyncPreferences.resetDownloadHistory()
                    refreshTick += 1
                }
                Button("Abbrechen", role: .cancel) {}
            } message: {
                Text("Der Upload- und Download-Verlauf wird geleert. Beim nächsten Sync werden alle Fotos erneut geprüft und ggf. übertragen.")
            }
        }
        .navigationTitle("Foto-Synchronisierung")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            refreshTick += 1
            queueObserver.startObserving()
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
    }
}
