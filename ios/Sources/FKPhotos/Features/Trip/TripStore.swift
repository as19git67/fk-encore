import Foundation
import Observation
import Photos

/// Single source of truth for Trip Mode. Mirrors the `SyncProgress.shared`
/// pattern (`@Observable @MainActor` singleton) so both the Trip tab and the
/// tab-bar icon can observe the active-trip state.
///
/// Provisioning reuses the existing album-sync machinery: it creates an iOS
/// album, links it to a server album (find-or-create by name, mirroring
/// `LibraryBrowserViewModel.makeAvailable`), and writes the standard
/// `PhotoSyncPreferences` mapping/mode. From then on the normal upload/download
/// pipeline handles the trip album unchanged.
@Observable @MainActor
final class TripStore {
    static let shared = TripStore()

    private(set) var activeTrip: ActiveTrip?
    /// True while a trip is being provisioned (album + server link), so the UI
    /// can show progress and block a second concurrent start.
    private(set) var isProvisioning = false

    private init() {
        activeTrip = TripPreferences.loadActiveTrip()
    }

    var isActive: Bool { activeTrip != nil }

    enum TripError: LocalizedError {
        case albumCreationFailed
        case serverAlbum(String)

        var errorDescription: String? {
            switch self {
            case .albumCreationFailed: return "iOS-Album konnte nicht erstellt werden"
            case .serverAlbum(let message): return message
            }
        }
    }

    // MARK: - Lifecycle

    /// Starts a solo trip: creates an iOS album, links it to a server album,
    /// sets the sync mode (default `sync`) and persists the active trip. The
    /// caller must have ensured read-write photo access.
    func startTrip(
        name: String,
        geofence: ActiveTrip.Geofence? = nil,
        autoAdd: Bool = true
    ) async throws {
        guard activeTrip == nil, !isProvisioning else { return }
        isProvisioning = true
        defer { isProvisioning = false }

        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let albumName = trimmed.isEmpty ? Self.defaultTripName() : trimmed

        let iosAlbumId = try await createIOSAlbum(named: albumName)
        let serverAlbumId = try await findOrCreateServerAlbum(named: albumName)

        // Wire into the existing per-album sync config. Default mode `sync` so
        // iPhone-seitiges Aussortieren auch das Server-Album abgleicht.
        let mode: PhotoSyncMode = .sync
        var selected = PhotoSyncPreferences.selectedAlbumIds
        selected.insert(iosAlbumId)
        PhotoSyncPreferences.selectedAlbumIds = selected

        var mappings = PhotoSyncPreferences.albumMappings
        mappings[iosAlbumId] = serverAlbumId
        PhotoSyncPreferences.albumMappings = mappings

        PhotoSyncPreferences.confirmMapping(for: iosAlbumId)
        PhotoSyncPreferences.setAlbumSyncMode(mode, for: iosAlbumId)
        PhotoSyncPreferences.syncEnabled = true
        PhotoSyncPreferences.setAlbumSyncDate(Date(), for: iosAlbumId)

        let trip = ActiveTrip(
            serverAlbumId: serverAlbumId,
            iosAlbumId: iosAlbumId,
            name: albumName,
            startedAt: Date(),
            endedAt: nil,
            autoAdd: autoAdd,
            mode: mode,
            geofence: geofence,
            handledAssetIds: [],
            dismissedAssetIds: [],
            isShared: false,
            ownerUserId: nil
        )
        activeTrip = trip
        TripPreferences.saveActiveTrip(trip)

        BackgroundSyncManager.shared.scheduleNextSyncIfNeeded()
    }

    /// Ends (freezes) the active trip: new photos are no longer treated as trip
    /// photos. The iOS album, server album and sync link stay in place — the
    /// album becomes a normal linked album that keeps syncing in its current
    /// mode. Deliberately non-destructive (matches the album-disconnect flow).
    func endTrip() {
        activeTrip = nil
        TripPreferences.saveActiveTrip(nil)
    }

    /// Changes the sync mode of the active trip's album (copy/sync/bisync).
    func setMode(_ mode: PhotoSyncMode) {
        guard var trip = activeTrip else { return }
        PhotoSyncPreferences.setAlbumSyncMode(mode, for: trip.iosAlbumId)
        trip.mode = mode
        activeTrip = trip
        TripPreferences.saveActiveTrip(trip)
        if mode == .sync || mode == .bisync {
            BackgroundSyncManager.shared.scheduleNextSyncIfNeeded()
        }
    }

    /// Toggles automatic photo adding (Auto) vs. manual review (Etappe 2). The
    /// flag is read by the auto-add pass (Etappe 1c); here it is only persisted.
    func setAutoAdd(_ enabled: Bool) {
        guard var trip = activeTrip else { return }
        trip.autoAdd = enabled
        activeTrip = trip
        TripPreferences.saveActiveTrip(trip)
    }

    // MARK: - Helpers

    /// Default trip name when no location-based suggestion is available (or the
    /// user cleared the field): "Trip <lokales Datum>".
    static func defaultTripName() -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return "Trip \(formatter.string(from: Date()))"
    }

    /// Creates a fresh regular iOS album and returns its `localIdentifier`.
    /// Confirms the collection resolves (mirrors
    /// `PhotoDownloadService.getOrCreateIOSAlbum`).
    private func createIOSAlbum(named name: String) async throws -> String {
        var createdId: String?
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges {
                let request = PHAssetCollectionChangeRequest.creationRequestForAssetCollection(withTitle: name)
                createdId = request.placeholderForCreatedAssetCollection.localIdentifier
            } completionHandler: { _, error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }
        guard let id = createdId,
              PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [id], options: nil).firstObject != nil
        else {
            throw TripError.albumCreationFailed
        }
        return id
    }

    /// Finds a matching server album by name (own, else shared-with-write) or
    /// creates a new one. Mirrors `LibraryBrowserViewModel.makeAvailable`.
    private func findOrCreateServerAlbum(named name: String) async throws -> Int {
        do {
            let response: ListAlbumsResponse = try await APIClient.shared.get("/albums")
            if let own = response.albums.first(where: { $0.name == name && $0.my_access_level == "owner" }) {
                return own.id
            }
            if let shared = response.albums.first(where: { $0.name == name && $0.hasWriteAccess }) {
                return shared.id
            }
        } catch {
            throw TripError.serverAlbum("Server-Alben konnten nicht geladen werden: \(error.localizedDescription)")
        }

        struct Body: Encodable { let name: String; let description: String? }
        struct CreatedAlbum: Decodable { let id: Int }
        do {
            let created: CreatedAlbum = try await APIClient.shared.post(
                "/albums", body: Body(name: name, description: nil)
            )
            return created.id
        } catch {
            throw TripError.serverAlbum("Album konnte nicht erstellt werden: \(error.localizedDescription)")
        }
    }
}
