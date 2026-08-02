import Photos
import SwiftUI

/// Entry point of the "Trip" tab.
///
/// Etappe 1b-i: Trip-Lebenszyklus (starten/beenden), Modus- und Auto/Manuell-
/// Optionen und das Foto-Grid des Trip-Albums. Ortsermittlung + Geofende
/// (CoreLocation) folgen in 1b-ii, der automatische Foto-Zuwachs in 1c
/// (siehe `docs/ios-trip-mode.md`).
struct TripView: View {
    @State private var store = TripStore.shared
    @State private var showStartSheet = false
    @State private var errorMessage: String?
    @State private var showError = false

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
        .sheet(isPresented: $showStartSheet) {
            TripStartSheet { name, geofence in
                Task { await start(name: name, geofence: geofence) }
            }
        }
        .alert("Fehler", isPresented: $showError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private var noTripView: some View {
        ContentUnavailableView {
            Label("Kein aktiver Trip", systemImage: "map")
        } description: {
            Text("Starte einen Trip, damit neue Fotos automatisch in ein gemeinsames Reise-Album synchronisiert werden – ohne vorher ein Album anzulegen.")
        } actions: {
            Button("Trip starten") { showStartSheet = true }
                .buttonStyle(.borderedProminent)
                .disabled(store.isProvisioning)
        }
    }

    private func start(name: String, geofence: ActiveTrip.Geofence?) async {
        // Read-write access is required to create the iOS album.
        let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        guard status == .authorized || status == .limited else {
            errorMessage = "Bitte erlaube den Zugriff auf die Fotos, um einen Trip zu starten."
            showError = true
            return
        }
        do {
            try await store.startTrip(name: name, geofence: geofence)
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

    @State private var assets: [PHAsset] = []
    @State private var isLoading = true
    @State private var showEndConfirm = false
    @State private var showShareSheet = false

    private let columns = [GridItem(.adaptive(minimum: 100, maximum: 150), spacing: 2)]

    var body: some View {
        VStack(spacing: 0) {
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
