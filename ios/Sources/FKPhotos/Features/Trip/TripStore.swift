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
    /// Ended trips still inside their catch-up grace period. They no longer
    /// accept new photos beyond their `endedAt`, but the catch-up pass keeps
    /// filling their album with photos taken *before* the trip ended that the
    /// app never got to see (it was suspended while the user was shooting).
    private(set) var closedTrips: [ActiveTrip] = []
    /// True while a trip is being provisioned (album + server link), so the UI
    /// can show progress and block a second concurrent start.
    private(set) var isProvisioning = false
    /// The most recent auto-add pass. New triggers chain onto it instead of
    /// being dropped — see `runAutoAddPass()`.
    private var passTask: Task<Int, Never>?

    private init() {
        activeTrip = TripPreferences.loadActiveTrip()
        closedTrips = TripPreferences.loadClosedTrips()
    }

    var isActive: Bool { activeTrip != nil }

    /// Whether the auto-add pass has anything to look at: a running trip, or an
    /// ended one still inside its catch-up grace period.
    var hasPendingTripWork: Bool { activeTrip != nil || !closedTrips.isEmpty }

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

    /// Ends (freezes) the active trip: photos taken from now on are no longer
    /// trip photos. The iOS album, server album and sync link stay in place —
    /// the album becomes a normal linked album that keeps syncing in its
    /// current mode. Deliberately non-destructive (matches the album-disconnect
    /// flow).
    ///
    /// The trip is **not** discarded: it moves to `closedTrips` with its
    /// `endedAt` stamped, so the catch-up pass can still add photos that were
    /// taken during the trip but never seen by the app (it only observes the
    /// photo library while it is running). The stamped end is what bounds that
    /// late catch-up — nothing shot after it can slip into the trip album.
    func endTrip() {
        guard var trip = activeTrip else { return }
        trip.endedAt = Date()
        closedTrips.append(trip)
        TripPreferences.saveClosedTrips(closedTrips)
        activeTrip = nil
        TripPreferences.saveActiveTrip(nil)

        // Run the final catch-up right away — the app is in the foreground, so
        // this is the cheapest moment to close the window.
        Task { [weak self] in
            guard let self else { return }
            let added = await self.runAutoAddPass()
            guard added > 0 else { return }
            try? await BackgroundSyncManager.shared.runFullSync()
        }
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

    /// Adds trip photos the app hasn't handled yet to their trip album and
    /// returns how many were added. Idempotent and safe to run repeatedly — it
    /// is the catch-up that runs **before every sync** (`runFullSync`, i.e. app
    /// open, foreground resume and the background task) as well as reactively
    /// from `PHPhotoLibraryChangeObserver`.
    ///
    /// Processes the active trip *and* every ended trip still inside its grace
    /// period. The app only sees the photo library while it runs, so a photo
    /// taken with the Camera app — possibly the last one before the user ended
    /// the trip — is regularly discovered long after the fact. The ended trip's
    /// `endedAt` bounds that: nothing taken after the trip ended is added.
    ///
    /// Membership rule (`TripMembership.includes`): image assets inside
    /// `[startedAt, endedAt]` and, when a geofence is set, within its radius
    /// (assets without GPS are included).
    ///
    /// The `handledAssetIds` set makes each asset get added **at most once**:
    /// once handled it is never re-added, so an aussortiertes Foto stays out and
    /// the `sync` mode can propagate the removal to the server without the
    /// auto-add pass fighting it (see `docs/ios-trip-mode.md` §4).
    ///
    /// Concurrent triggers are **chained, not dropped**: `@MainActor` methods
    /// interleave at their `await` points, so the sync's catch-up and the
    /// library observer can overlap. Dropping one used to mean a photo taken
    /// during a running pass waited for the next trigger; instead every caller
    /// gets a pass that starts after it asked. A follow-up pass with nothing new
    /// to do returns immediately, so the chain terminates.
    @discardableResult
    func runAutoAddPass() async -> Int {
        guard hasPendingTripWork else { return 0 }

        let previous = passTask
        let task = Task { @MainActor [weak self] in
            _ = await previous?.value
            guard let self else { return 0 }
            return await self.performAutoAddPass()
        }
        passTask = task
        let added = await task.value
        if passTask == task { passTask = nil }
        return added
    }

    /// One pass over the active trip and the pending ended trips.
    private func performAutoAddPass() async -> Int {
        purgeExpiredClosedTrips()

        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else { return 0 }

        var added = 0
        // Ended trips first: their window is closed, so finishing them frees
        // the pending list as early as possible.
        for trip in closedTrips where trip.autoAdd {
            added += await addPass(for: trip, isActive: false)
        }
        if let trip = activeTrip, trip.autoAdd {
            added += await addPass(for: trip, isActive: true)
        }
        return added
    }

    /// Adds the not-yet-handled window assets of a single trip to its album and
    /// returns how many were newly handled.
    private func addPass(for trip: ActiveTrip, isActive: Bool) async -> Int {
        let handled = Set(trip.handledAssetIds)
        let candidates = await Self.fetchTripCandidates(for: trip, excluding: handled)
        guard !candidates.isEmpty else { return 0 }

        let added = await Self.addAssets(localIds: candidates, toAlbum: trip.iosAlbumId)
        guard !added.isEmpty else { return 0 }

        return recordHandled(added, forAlbum: trip.iosAlbumId, isActive: isActive)
    }

    /// Extends a trip's handled set, re-reading the trip first: it may have been
    /// ended or replaced while we were awaiting the photo-library change.
    private func recordHandled(_ ids: [String], forAlbum albumId: String, isActive: Bool) -> Int {
        func extend(_ trip: inout ActiveTrip) -> Int {
            let existing = Set(trip.handledAssetIds)
            let newlyHandled = ids.filter { !existing.contains($0) }
            trip.handledAssetIds.append(contentsOf: newlyHandled)
            return newlyHandled.count
        }

        if isActive {
            guard var current = activeTrip, current.iosAlbumId == albumId else { return 0 }
            let count = extend(&current)
            guard count > 0 else { return 0 }
            activeTrip = current
            TripPreferences.saveActiveTrip(current)
            return count
        }

        guard let index = closedTrips.firstIndex(where: { $0.iosAlbumId == albumId }) else { return 0 }
        let count = extend(&closedTrips[index])
        guard count > 0 else { return 0 }
        TripPreferences.saveClosedTrips(closedTrips)
        return count
    }

    /// Drops ended trips that have outlived their grace period.
    private func purgeExpiredClosedTrips() {
        let now = Date()
        let remaining = closedTrips.filter { !TripMembership.isExpired($0, now: now) }
        guard remaining.count != closedTrips.count else { return }
        closedTrips = remaining
        TripPreferences.saveClosedTrips(remaining)
    }

    /// Enumerates image assets in the trip's capture window (and geofence) that
    /// haven't been handled yet. Runs off the main thread — enumeration reads
    /// asset metadata and shouldn't block the cooperative pool.
    ///
    /// The window bounds go into the fetch predicate so the store does the
    /// filtering; `TripMembership.includes` then re-checks each candidate,
    /// which is what applies the geofence.
    private static func fetchTripCandidates(
        for trip: ActiveTrip,
        excluding handled: Set<String>
    ) async -> [String] {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let options = PHFetchOptions()
                var format = "mediaType == %d AND creationDate >= %@"
                var arguments: [Any] = [PHAssetMediaType.image.rawValue, trip.startedAt as NSDate]
                if let endedAt = trip.endedAt {
                    format += " AND creationDate <= %@"
                    arguments.append(endedAt as NSDate)
                }
                options.predicate = NSPredicate(format: format, argumentArray: arguments)
                options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]

                var result: [String] = []
                PHAsset.fetchAssets(with: .image, options: options).enumerateObjects { asset, _, _ in
                    let id = asset.localIdentifier
                    if handled.contains(id) { return }
                    guard TripMembership.includes(
                        creationDate: asset.creationDate,
                        location: asset.location,
                        trip: trip
                    ) else { return }
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
