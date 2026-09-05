import Photos
import SwiftUI

/// Entry point of the "Trip" tab.
///
/// Trip-Lebenszyklus (starten/beenden), Modus- und Auto/Manuell-Optionen und
/// das Foto-Grid des Trip-Albums. Ortsermittlung beim Start liefert den
/// Namensvorschlag, der automatische Foto-Zuwachs läuft über den Auto-Add-Pass
/// (siehe `docs/ios-trip-mode.md`).
struct TripView: View {
    @State private var store = TripStore.shared
    @State private var autoStart = TripAutoStartMonitor.shared
    @Environment(\.scenePhase) private var scenePhase
    @State private var showStartSheet = false
    /// Prefill handed to `TripStartSheet`. Set from the auto-start suggestion,
    /// `nil` for a manual start.
    @State private var startSheetName: String?
    @State private var errorMessage: String?
    @State private var showError = false
    /// A planned trip (§8.1) whose dates say it is happening today.
    /// Loaded so the two halves of "Reise" can find each other: the one
    /// you planned and the one your photos go into.
    @State private var runningPlan: TripPlanSummary?
    /// The planned trip the toolbar link should open, when the tap came
    /// from the banner.
    @State private var openPlans = false

    var body: some View {
        Group {
            if let trip = store.activeTrip {
                ActiveTripView(trip: trip, store: store)
            } else {
                noTripView
            }
        }
        .navigationTitle("Trip")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // The vacation planner lives next to trip mode rather than in
            // a tab of its own: one is the trip you are on, the other the
            // trip you are planning, and the tab bar is full.
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink {
                    TripPlansListView()
                } label: {
                    Label("Urlaubsplanung", systemImage: "calendar.badge.clock")
                }
            }
        }
        .sheet(isPresented: $showStartSheet) {
            TripStartSheet(suggestedName: startSheetName) { name in
                Task { await start(name: name) }
            }
        }
        .alert("Fehler", isPresented: $showError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
        .navigationDestination(isPresented: $openPlans) { TripPlansListView() }
        .onAppear { consumeStartSuggestionHandoff() }
        .task { await loadRunningPlan() }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active {
                consumeStartSuggestionHandoff()
                Task { await loadRunningPlan() }
            }
        }
    }

    /// Is one of the planned trips happening today?
    ///
    /// Answered from the dates rather than from anything anybody
    /// pressed. A "start" button would have to be pressed on the one
    /// morning nobody has their phone out, and it would be wrong the
    /// moment a flight moved.
    @MainActor
    private func loadRunningPlan() async {
        guard !store.isActive else {
            runningPlan = nil
            return
        }
        do {
            let response: ListTripPlansResponse =
                try await APIClient.shared.get("/trip-planner/plans")
            let today = Date()
            runningPlan = response.plans.first { $0.schedule(on: today).isRunning }
        } catch {
            // Silent: this is an offer, not a feature. A planner that
            // cannot be reached must not put an error on the trip tab.
            runningPlan = nil
        }
    }

    /// Opens the prefilled start sheet when the user chose "Trip starten" on
    /// the suggestion notification. That action deliberately doesn't start the
    /// trip itself — the name becomes an iOS *and* a server album, so it wants
    /// confirming (`docs/ios-trip-mode.md` §9.2).
    @MainActor
    private func consumeStartSuggestionHandoff() {
        guard !store.isActive, let name = autoStart.consumeStartSheetRequest() else { return }
        startSheetName = name
        showStartSheet = true
    }

    @ViewBuilder private var noTripView: some View {
        VStack(spacing: 0) {
            if let suggestion = autoStart.pendingSuggestion {
                autoStartBanner(suggestion)
                Divider()
            } else if let runningPlan {
                plannedTripBanner(runningPlan)
                Divider()
            }
            ContentUnavailableView {
                Label("Kein aktiver Trip", systemImage: "map")
            } description: {
                Text("Starte einen Trip, damit neue Fotos automatisch in ein gemeinsames Reise-Album synchronisiert werden – ohne vorher ein Album anzulegen.")
            } actions: {
                Button("Trip starten") {
                    startSheetName = nil
                    showStartSheet = true
                }
                .buttonStyle(.borderedProminent)
                .disabled(store.isProvisioning)
            }
        }
    }

    /// The planned trip is happening today, and trip mode is not on.
    ///
    /// The two "Reise" halves are separate on purpose — you plan months
    /// ahead and you photograph on the day — but nothing connected them,
    /// so a traveller standing on Marienplatz with a planned Munich trip
    /// saw no sign of it. This is that connection, and it is an offer
    /// rather than an automatism: starting trip mode creates an album,
    /// which is not something to do behind somebody's back.
    @MainActor
    private func plannedTripBanner(_ plan: TripPlanSummary) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Image(systemName: "calendar.badge.clock")
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text("„\(plan.displayTitle)“ läuft heute")
                        .font(.subheadline.weight(.semibold))
                    Text(plan.schedule(on: Date()).label)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            HStack(spacing: 8) {
                Button("Trip starten") {
                    startSheetName = plan.displayTitle
                    showStartSheet = true
                }
                .buttonStyle(.borderedProminent)
                Button("Plan öffnen") { openPlans = true }
                    .buttonStyle(.bordered)
                Spacer()
            }
        }
        .padding()
        .background(.thinMaterial)
    }

    /// Fallback for the auto-start suggestion when the notification was denied,
    /// missed or ignored — the mirror of `ActiveTripView`'s auto-end banner.
    @MainActor
    private func autoStartBanner(_ suggestion: PendingStartSuggestion) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Image(systemName: "airplane.departure")
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Sieht aus, als wärst du unterwegs")
                        .font(.subheadline.weight(.semibold))
                    Text("\(suggestion.suggestedName) – seit \(suggestion.travellingSince.formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            HStack(spacing: 8) {
                Button("Trip starten") {
                    startSheetName = suggestion.suggestedName
                    autoStart.dismissSuggestion()
                    showStartSheet = true
                }
                .buttonStyle(.borderedProminent)
                Button("Nicht jetzt") { autoStart.dismissSuggestion() }
                    .buttonStyle(.bordered)
                Spacer()
                Button("Hier nie fragen") { autoStart.suppressCurrentRegion() }
                    .buttonStyle(.borderless)
                    .font(.caption)
            }
        }
        .padding()
        .background(.thinMaterial)
    }

    private func start(name: String) async {
        // Read-write access is required to create the iOS album.
        let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        guard status == .authorized || status == .limited else {
            errorMessage = "Bitte erlaube den Zugriff auf die Fotos, um einen Trip zu starten."
            showError = true
            return
        }
        do {
            try await store.startTrip(name: name)
        } catch {
            errorMessage = error.localizedDescription
            showError = true
        }
    }
}

// MARK: - Active trip

private struct ActiveTripView: View {
    let trip: ActiveTrip
    let store: TripStore

    @Environment(\.scenePhase) private var scenePhase
    @State private var assets: [PHAsset] = []
    @State private var isLoading = true
    @State private var showEndConfirm = false
    @State private var showShareSheet = false
    /// Mirrors `TripAutoEndPreferences.pendingSuggestion` for this trip. Read
    /// fresh on appear and whenever the app returns to the foreground — the
    /// suggestion is normally raised and answered via the notification while
    /// the app isn't running, so this banner is the fallback for when
    /// notifications are denied or the user opens the app instead of using the
    /// notification's actions.
    @State private var autoEndSuggestion: PendingAutoEndSuggestion?

    private let columns = [GridItem(.adaptive(minimum: 100, maximum: 150), spacing: 2)]

    var body: some View {
        VStack(spacing: 0) {
            if autoEndSuggestion != nil {
                autoEndBanner
                Divider()
            }
            optionsBar
            Divider()
            grid
        }
        // Re-keyed on the auto-add pass's progress marker so the grid refreshes
        // after new trip photos were added (the parent re-renders with an
        // updated trip). The watermark moves on every pass that saw something
        // new; the edge count covers the rare pass that added a photo sitting on
        // the watermark instant itself.
        .task(id: """
            \(trip.iosAlbumId)-\
            \(trip.handledWatermark?.timeIntervalSince1970 ?? 0)-\
            \(trip.handledAssetIds.count)
            """) {
            assets = await Self.loadAssets(albumId: trip.iosAlbumId)
            isLoading = false
        }
        .confirmationDialog(
            "Trip beenden?",
            isPresented: $showEndConfirm,
            titleVisibility: .visible
        ) {
            Button("Trip beenden", role: .destructive) { store.endTrip() }
            Button("Abbrechen", role: .cancel) {}
        } message: {
            Text("Neue Fotos werden nicht mehr automatisch hinzugefügt. Das Album und die bereits synchronisierten Fotos bleiben erhalten.")
        }
        // Sharing the trip album straight from the trip view (issue #918): the
        // trip syncs into an ordinary server album, so the regular album share
        // UI applies unchanged.
        .sheet(isPresented: $showShareSheet) {
            AlbumShareView(albumId: trip.serverAlbumId, albumName: trip.name)
        }
        .onAppear { refreshAutoEndSuggestion() }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active { refreshAutoEndSuggestion() }
        }
    }

    private func refreshAutoEndSuggestion() {
        let pending = TripAutoEndPreferences.pendingSuggestion
        autoEndSuggestion = pending?.tripIosAlbumId == trip.iosAlbumId ? pending : nil
    }

    private var autoEndBanner: some View {
        HStack(spacing: 12) {
            Image(systemName: "house.fill")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text("Bist du zurück?")
                    .font(.subheadline.weight(.semibold))
                Text("Sieht so aus, als wärst du wieder zuhause.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Beenden") {
                TripAutoEndMonitor.shared.dismissSuggestion(forTripAlbumId: trip.iosAlbumId)
                autoEndSuggestion = nil
                store.endTrip()
            }
            .buttonStyle(.borderedProminent)
            Button("Nein") {
                TripAutoEndMonitor.shared.dismissSuggestion(forTripAlbumId: trip.iosAlbumId)
                autoEndSuggestion = nil
            }
            .buttonStyle(.bordered)
        }
        .padding()
        .background(.thinMaterial)
    }

    private var optionsBar: some View {
        VStack(spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(trip.name)
                        .font(.headline)
                    Text("seit \(trip.startedAt.formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button { showShareSheet = true } label: {
                    Label("Teilen", systemImage: "person.crop.circle.badge.plus")
                        .labelStyle(.titleAndIcon)
                }
                .buttonStyle(.bordered)
                Button(role: .destructive) { showEndConfirm = true } label: {
                    Text("Beenden")
                }
                .buttonStyle(.bordered)
            }

            HStack {
                Picker("Modus", selection: Binding(
                    get: { trip.mode },
                    set: { store.setMode($0) }
                )) {
                    Text("Kopieren").tag(PhotoSyncMode.copy)
                    Text("Synchronisieren").tag(PhotoSyncMode.sync)
                    Text("Zwei-Wege").tag(PhotoSyncMode.bisync)
                }
                .pickerStyle(.menu)

                Spacer()

                Text(trip.autoAdd ? "Automatisch" : "Manuell")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Toggle("Automatisch hinzufügen", isOn: Binding(
                    get: { trip.autoAdd },
                    set: { store.setAutoAdd($0) }
                ))
                .labelsHidden()
            }
        }
        .padding()
    }

    @ViewBuilder private var grid: some View {
        if isLoading {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if assets.isEmpty {
            ContentUnavailableView {
                Label("Noch keine Trip-Fotos", systemImage: "photo")
            } description: {
                Text(trip.autoAdd
                     ? "Neue Fotos, die du jetzt aufnimmst, werden automatisch hinzugefügt."
                     : "Im manuellen Modus fügst du Fotos später über die Auswahl hinzu.")
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 2) {
                    ForEach(assets, id: \.localIdentifier) { asset in
                        LibraryPhotoCell(asset: asset)
                    }
                }
                .padding(.horizontal, 2)
            }
        }
    }

    /// Loads the trip album's image assets (newest first). Returns an empty
    /// array when the collection can't be resolved.
    private static func loadAssets(albumId: String) async -> [PHAsset] {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let collections = PHAssetCollection.fetchAssetCollections(
                    withLocalIdentifiers: [albumId], options: nil
                )
                guard let collection = collections.firstObject else {
                    continuation.resume(returning: [])
                    return
                }
                let options = PHFetchOptions()
                options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
                options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
                var list: [PHAsset] = []
                PHAsset.fetchAssets(in: collection, options: options).enumerateObjects { asset, _, _ in
                    list.append(asset)
                }
                continuation.resume(returning: list)
            }
        }
    }
}
