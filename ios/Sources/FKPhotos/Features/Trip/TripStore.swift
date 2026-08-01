import CoreLocation
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
    /// Guards against overlapping auto-add passes. `@MainActor` methods can
    /// still interleave at their `await` points, so two triggers (runFullSync
    /// catch-up + the library-change observer) could otherwise process the same
    /// candidates twice.
    private var isAutoAdding = false

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

    // MARK: - Auto-add pass (Etappe 1c)

    /// Adds newly-captured trip photos to the trip's iOS album and returns how
    /// many were added. Idempotent and safe to run repeatedly (`runFullSync`
    /// catch-up + `PHPhotoLibraryChangeObserver`).
    ///
    /// Membership rule: image assets with `creationDate >= startedAt` (and, when
    /// a geofence is set, within its radius — assets without GPS are included).
    ///
    /// The `handledAssetIds` set makes each asset get added **at most once**:
    /// once handled it is never re-added, so an aussortiertes Foto stays out and
    /// the `sync` mode can propagate the removal to the server without the
    /// auto-add pass fighting it (see `docs/ios-trip-mode.md` §4). No-op unless
    /// a trip is active and in Auto mode.
    @discardableResult
    func runAutoAddPass() async -> Int {
        guard let trip = activeTrip, trip.autoAdd else { return 0 }
        guard !isAutoAdding else { return 0 }
        isAutoAdding = true
        defer { isAutoAdding = false }

        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else { return 0 }

        let handled = Set(trip.handledAssetIds)
        let candidates = await Self.fetchTripCandidates(
            since: trip.startedAt,
            geofence: trip.geofence,
            excluding: handled
        )
        guard !candidates.isEmpty else { return 0 }

        let added = await Self.addAssets(localIds: candidates, toAlbum: trip.iosAlbumId)
        guard !added.isEmpty else { return 0 }

        // Re-read in case the trip changed while we were adding, and only extend
        // the same trip's handled set (de-duplicated).
        guard var current = activeTrip, current.iosAlbumId == trip.iosAlbumId else { return 0 }
        let existing = Set(current.handledAssetIds)
        let newlyHandled = added.filter { !existing.contains($0) }
        guard !newlyHandled.isEmpty else { return 0 }
        current.handledAssetIds.append(contentsOf: newlyHandled)
        activeTrip = current
        TripPreferences.saveActiveTrip(current)
        return newlyHandled.count
    }

    /// Enumerates image assets in the trip's time window (and geofence) that
    /// haven't been handled yet. Runs off the main thread — enumeration reads
    /// asset metadata and shouldn't block the cooperative pool.
    private static func fetchTripCandidates(
        since: Date,
        geofence: ActiveTrip.Geofence?,
        excluding handled: Set<String>
    ) async -> [String] {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let options = PHFetchOptions()
                options.predicate = NSPredicate(
                    format: "mediaType == %d AND creationDate >= %@",
                    PHAssetMediaType.image.rawValue, since as NSDate
                )
                options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]

                let center = geofence.map { CLLocation(latitude: $0.latitude, longitude: $0.longitude) }
                let radius = geofence?.radiusMeters

                var result: [String] = []
                PHAsset.fetchAssets(with: .image, options: options).enumerateObjects { asset, _, _ in
                    let id = asset.localIdentifier
                    if handled.contains(id) { return }
                    // Geofence refinement: exclude located assets outside the
                    // radius. Assets without GPS are included (Etappe-1-Entscheidung).
                    if let center, let radius, let location = asset.location,
                       location.distance(from: center) > radius {
                        return
                    }
                    result.append(id)
                }
                continuation.resume(returning: result)
            }
        }
    }

    /// Adds the given assets to the album. Returns the local identifiers that
    /// were resolvable and passed to the change request (empty on failure).
    /// Adding an asset already in the album is a no-op in PhotoKit.
    private static func addAssets(localIds: [String], toAlbum albumId: String) async -> [String] {
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: localIds, options: nil)
        guard assets.count > 0 else { return [] }
        let collections = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [albumId], options: nil)
        guard let album = collections.firstObject else { return [] }

        var resolvedIds: [String] = []
        assets.enumerateObjects { asset, _, _ in resolvedIds.append(asset.localIdentifier) }

        do {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                PHPhotoLibrary.shared().performChanges {
                    PHAssetCollectionChangeRequest(for: album)?.addAssets(assets)
                } completionHandler: { _, error in
                    if let error { cont.resume(throwing: error) } else { cont.resume() }
                }
            }
        } catch {
            return []
        }
        return resolvedIds
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
        // Trimmed on both sides so a trailing space can't spawn a duplicate
        // server album (issue #849).
        let serverName = AlbumName.normalized(name)
        do {
            let response: ListAlbumsResponse = try await APIClient.shared.get("/albums")
            if let own = response.albums.first(where: {
                AlbumName.matches($0.name, serverName) && $0.my_access_level == "owner"
            }) {
                return own.id
            }
            if let shared = response.albums.first(where: {
                AlbumName.matches($0.name, serverName) && $0.hasWriteAccess
            }) {
                return shared.id
            }
        } catch {
            throw TripError.serverAlbum("Server-Alben konnten nicht geladen werden: \(error.localizedDescription)")
        }

        struct Body: Encodable { let name: String; let description: String? }
        struct CreatedAlbum: Decodable { let id: Int }
        do {
            let created: CreatedAlbum = try await APIClient.shared.post(
                "/albums", body: Body(name: serverName, description: nil)
            )
            return created.id
        } catch {
            throw TripError.serverAlbum("Album konnte nicht erstellt werden: \(error.localizedDescription)")
        }
    }
}
