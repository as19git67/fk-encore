import BackgroundTasks
import CoreLocation
import Foundation
import ImageIO
import Photos
import UIKit

/// Manages registration and scheduling of the background photo-sync processing task,
/// and drains the shared UploadQueue during background execution.
///
/// iOS 26.1+: Use PHAssetResourceUploadJobChangeRequest to create system-managed
/// background upload jobs. The system invokes the app's
/// `com.apple.photos.background-upload` extension (PHBackgroundResourceUploadExtension)
/// when uploads are ready — requires a separate Xcode extension target.
///
/// iOS < 26.1 fallback: BGProcessingTask triggers PhotoSyncService.sync(), which
/// processes uploads in-process while the system gives background time.
public final class BackgroundSyncManager {
    public static let shared = BackgroundSyncManager()

    private init() {}

    /// Serialises drain calls. Two concurrent drains used to pick up the same
    /// pending items and re-upload them; that race accounted for the ~10 %
    /// server-side duplicates because the dedup queries ran *before* either
    /// insert had committed. Combined with per-item `.uploading` claiming in
    /// `UploadQueue`, this guarantees each item is uploaded at most once per
    /// drain pass.
    private let drainLock = DrainLock()

    private actor DrainLock {
        private var draining = false
        /// Returns true when the caller has the lock; false when another drain
        /// is already in progress (caller should bail out).
        func tryAcquire() -> Bool {
            if draining { return false }
            draining = true
            return true
        }
        func release() { draining = false }
    }

    /// Serialises full-pipeline runs so the manual "Jetzt synchronisieren"
    /// trigger, the foreground-resume auto-continue and the background task
    /// never run two upload+download pipelines against each other.
    private let pipelineLock = DrainLock()

    // MARK: - Registration (call once at launch)

    public func register() {
        // Recover installs poisoned by the old watermark bug before anything
        // else touches the sync state (runs at most once).
        PhotoSyncPreferences.runWatermarkPoisonMigrationIfNeeded()

        print("[BGSync] Registering task: \(PhotoSyncPreferences.taskIdentifier)")
        let ok = BGTaskScheduler.shared.register(
            forTaskWithIdentifier: PhotoSyncPreferences.taskIdentifier,
            using: nil
        ) { [weak self] task in
            print("[BGSync] Handler called, task type: \(type(of: task))")
            guard let processingTask = task as? BGProcessingTask else {
                print("[BGSync] Cast to BGProcessingTask failed")
                task.setTaskCompleted(success: false)
                return
            }
            self?.handle(processingTask)
        }
        print("[BGSync] Registration result: \(ok)")

        // Reset any items that were stuck in "uploading" state from a previous run.
        Task { await UploadQueue.shared.resetStaleUploading() }
        Task { await UploadQueue.shared.load() }

        // Observe photo-library changes so a running trip picks up freshly-taken
        // photos promptly (Trip Mode Etappe 1c). No-op until a trip is active.
        TripPhotoLibraryObserver.shared.startIfNeeded()

        // Re-arm the auto-end location monitor if a trip was already active
        // before this launch — `TripAutoEndMonitor.isMonitoring` resets to
        // false on every process start, so without this a trip survives a
        // relaunch but silently stops being watched for "back home".
        Task { @MainActor in
            TripNotificationCategories.registerAll()
            TripAutoEndMonitor.shared.resumeIfTripActive()
        }
    }

    // MARK: - Scheduling

    /// Schedule the next sync run. Cancels the request if both upload and download are disabled.
    public func scheduleNextSyncIfNeeded() {
        guard PhotoSyncPreferences.syncEnabled
                || DownloadSyncPreferences.downloadEnabled
                || !PhotoSyncPreferences.bisyncServerAlbumIds().isEmpty else {
            BGTaskScheduler.shared.cancel(
                taskRequestWithIdentifier: PhotoSyncPreferences.taskIdentifier
            )
            return
        }

        let request = BGProcessingTaskRequest(identifier: PhotoSyncPreferences.taskIdentifier)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        request.earliestBeginDate = Date(timeIntervalSinceNow: 5 * 60)

        do {
            try BGTaskScheduler.shared.submit(request)
            print("[BGSync] Task scheduled: \(PhotoSyncPreferences.taskIdentifier)")
        } catch {
            print("[BGSync] Failed to schedule task: \(error)")
        }
    }

    // MARK: - iOS 26.1+ Background Upload Queue (PhotoKit)

    /// Enqueues an upload job via PhotoKit's background upload system (iOS 26.1+).
    /// The system's PHBackgroundResourceUploadExtension handler does the actual upload.
    /// Falls back to adding the item to UploadQueue for foreground processing on older iOS.
    ///
    /// - Parameter item: A fully prepared UploadQueueItem (temp file + all metadata).
    public func enqueueForBackgroundUpload(_ item: UploadQueueItem) {
        let item = refreshMetadataFromLibrary(item)
        if #available(iOS 26.1, *) {
            Task { await enqueuePHBackgroundJob(item) }
        } else {
            Task { await UploadQueue.shared.enqueue(item) }
        }
    }

    @available(iOS 26.1, *)
    private func enqueuePHBackgroundJob(_ item: UploadQueueItem) async {
        // The system runs this upload job later — possibly hours from now — but
        // the access token is baked into the request below and only lives 15
        // minutes. Refresh it right before baking so the token carries its full
        // lifetime into the system queue. (The system upload extension cannot
        // refresh on its own; that would require a dedicated
        // PHBackgroundResourceUploadExtension target. Until then this maximises
        // the odds the job runs before the token expires; if it still expires,
        // the job fails silently and the foreground drain re-uploads later.)
        await APIClient.shared.ensureFreshToken()

        let asset = item.assetLocalIdentifier.flatMap {
            PHAsset.fetchAssets(withLocalIdentifiers: [$0], options: nil).firstObject
        }
        guard let resource = asset.flatMap({ AssetUploadEnqueuer.bestResource(for: $0) }) else {
            // No PHAssetResource available (e.g. item came from Share Extension with file data only).
            // Fall back to UploadQueue for foreground processing.
            await UploadQueue.shared.enqueue(item)
            return
        }

        guard let baseURL = URL(string: SharedStorage.defaults.string(forKey: SharedStorage.serverURLKey) ?? ""),
              let token = KeychainHelper.loadString(forKey: "auth_token"),
              !token.isEmpty else {
            await UploadQueue.shared.enqueue(item)
            return
        }

        var request = URLRequest(url: baseURL.appendingPathComponent("/photos"))
        request.httpMethod = "POST"
        request.allowsCellularAccess = !PhotoSyncPreferences.wifiOnly
        request.setValue(item.mimeType, forHTTPHeaderField: "Content-Type")
        request.setValue(percentEncodeHeaderValue(item.filename), forHTTPHeaderField: "X-File-Name")
        request.setValue(item.imageDataHash, forHTTPHeaderField: "X-Image-Data-Hash")
        request.setValue(item.fullHash, forHTTPHeaderField: "X-Full-Hash")
        request.setValue(percentEncodeHeaderValue(item.caption), forHTTPHeaderField: "X-Description")
        request.setValue(item.isFavorite ? "true" : "false", forHTTPHeaderField: "X-Is-Favorite")
        request.setValue(item.capturedAtString, forHTTPHeaderField: "X-Captured-At")
        // Carry the asset id so the server dedups (and replaces on edit) by
        // device_asset_id, and the GPS fallback so the coordinate survives the
        // EXIF-stripped resource bytes — same contract as the foreground drain.
        if let localId = item.assetLocalIdentifier, !localId.isEmpty {
            request.setValue(localId, forHTTPHeaderField: "X-Asset-Id")
        }
        let latitude = asset?.location?.coordinate.latitude ?? item.latitude
        let longitude = asset?.location?.coordinate.longitude ?? item.longitude
        if let latitude, latitude.isFinite {
            request.setValue(String(latitude), forHTTPHeaderField: "X-GPS-Lat")
        }
        if let longitude, longitude.isFinite {
            request.setValue(String(longitude), forHTTPHeaderField: "X-GPS-Lng")
        }
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        do {
            try PHPhotoLibrary.shared().performChangesAndWait {
                PHAssetResourceUploadJobChangeRequest.createJob(destination: request, resource: resource)
            }
        } catch {
            print("[BGSync] PHAssetResourceUploadJobChangeRequest failed: \(error) — falling back to UploadQueue")
            await UploadQueue.shared.enqueue(item)
        }
    }

    // MARK: - Library metadata refresh

    /// Re-reads the favourite flag and caption from the Photos library for a
    /// queued item just before it is uploaded. The Share Extension cannot
    /// resolve a `PHAsset`, so it uploads with whatever it could read from the
    /// file alone — notably `isFavorite` is always `false`. The main app, which
    /// runs this code, does have full Photos access.
    ///
    /// Returns the item unchanged when it has no asset identifier, or when the
    /// asset is not in the Photos library — a photo shared into the app from
    /// another app, or when Photos access is unavailable. In that case only the
    /// metadata already captured at share time is used; there is no favourite
    /// to read. When the favourite/caption did change, `fullHash` is recomputed
    /// so the server still receives a consistent identity hash.
    private func refreshMetadataFromLibrary(_ item: UploadQueueItem) -> UploadQueueItem {
        guard let localId = item.assetLocalIdentifier, !localId.isEmpty,
              let asset = PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil).firstObject
        else {
            return item
        }
        let isFavorite = asset.isFavorite
        let caption = PhotoHasher.shared.captionFromAsset(asset) ?? item.caption
        guard isFavorite != item.isFavorite || caption != item.caption else { return item }
        return UploadQueueItem(
            id: item.id,
            assetLocalIdentifier: item.assetLocalIdentifier,
            tempFileURL: item.tempFileURL,
            filename: item.filename,
            mimeType: item.mimeType,
            imageDataHash: item.imageDataHash,
            fullHash: PhotoHasher.fullHash(
                imageDataHash: item.imageDataHash,
                caption: caption,
                isFavorite: isFavorite,
                capturedAtString: item.capturedAtString
            ),
            caption: caption,
            isFavorite: isFavorite,
            capturedAtString: item.capturedAtString,
            targetAlbumIds: item.targetAlbumIds,
            latitude: item.latitude,
            longitude: item.longitude,
            status: item.status,
            retryCount: item.retryCount
        )
    }

    // MARK: - Asset identifier recovery

    /// iOS hands a share extension only file bytes, never a `PHAsset`, so an
    /// item enqueued by the extension frequently has no `assetLocalIdentifier`.
    /// Without it the favourite flag can never be read, and the upload carries
    /// no `X-Asset-Id` so the server stores no `device_asset_id` — a later
    /// library auto-sync of the same photo then cannot deduplicate by asset id.
    ///
    /// The main app has full Photos access and can match the photo back to the
    /// library. Returns the item unchanged when it already has an identifier or
    /// no match is found.
    private func recoverAssetIdentifierIfMissing(_ item: UploadQueueItem) async -> UploadQueueItem {
        guard (item.assetLocalIdentifier ?? "").isEmpty else { return item }
        guard let recovered = await recoverAssetIdentifier(for: item) else { return item }
        print("[BGSync] Recovered asset id for queued item \(item.id)")
        return item.withAssetLocalIdentifier(recovered)
    }

    /// Matches a queued photo back to a library `PHAsset` and returns its
    /// `localIdentifier`, or nil when no exact match is found.
    ///
    /// The capture date narrows the search to a handful of candidates via the
    /// indexed `creationDate` — then the metadata-independent `imageDataHash`
    /// confirms the exact asset. The hash is byte-identical to the one the
    /// Share Extension stored, so a burst shot sharing the same capture second
    /// cannot produce a false positive.
    private func recoverAssetIdentifier(for item: UploadQueueItem) async -> String? {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else { return nil }
        guard let capturedAt = Self.captureDate(for: item) else { return nil }

        let tolerance: TimeInterval = 120
        let options = PHFetchOptions()
        options.predicate = NSPredicate(
            format: "mediaType == %d AND creationDate >= %@ AND creationDate <= %@",
            PHAssetMediaType.image.rawValue,
            capturedAt.addingTimeInterval(-tolerance) as NSDate,
            capturedAt.addingTimeInterval(tolerance) as NSDate
        )
        let fetch = PHAsset.fetchAssets(with: options)
        guard fetch.count > 0 else { return nil }

        var candidates: [PHAsset] = []
        fetch.enumerateObjects { asset, _, _ in candidates.append(asset) }

        for asset in candidates {
            if let hashes = await PhotoHasher.shared.hashes(for: asset),
               hashes.imageDataHash == item.imageDataHash {
                return asset.localIdentifier
            }
        }
        return nil
    }

    /// Reads the EXIF `DateTimeOriginal` of the shared file — the capture date
    /// used to narrow the library search. The Share Extension cannot resolve a
    /// PHAsset for these items, so its `capturedAtString` is empty; the file's
    /// own EXIF is the only capture date available.
    private static func captureDate(for item: UploadQueueItem) -> Date? {
        guard let fileURL = item.tempFileURL,
              let source = CGImageSourceCreateWithURL(fileURL as CFURL, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any],
              let original = exif[kCGImagePropertyExifDateTimeOriginal] as? String
        else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy:MM:dd HH:mm:ss"
        // The EXIF 2.31 offset tag pins the absolute instant when present;
        // otherwise assume the photo was taken in the device's current zone.
        if let offset = exif[kCGImagePropertyExifOffsetTimeOriginal] as? String,
           let zone = Self.timeZone(fromExifOffset: offset) {
            formatter.timeZone = zone
        } else {
            formatter.timeZone = TimeZone.current
        }
        return formatter.date(from: original)
    }

    /// Parses an EXIF offset string such as "+02:00" into a `TimeZone`.
    private static func timeZone(fromExifOffset offset: String) -> TimeZone? {
        let trimmed = offset.trimmingCharacters(in: .whitespaces)
        guard trimmed.count == 6,
              let hours = Int(trimmed.dropFirst().prefix(2)),
              let minutes = Int(trimmed.suffix(2)) else { return nil }
        let sign = trimmed.hasPrefix("-") ? -1 : 1
        return TimeZone(secondsFromGMT: sign * (hours * 3600 + minutes * 60))
    }

    // MARK: - Foreground queue drain (iOS < 26.1 / BGProcessingTask fallback)

    /// Drains pending UploadQueue items using the main app's network stack.
    /// Called from the BGProcessingTask handler and from the app foreground.
    ///
    /// Concurrency model:
    ///   * `drainLock` blocks a second concurrent drain (e.g. foreground tap
    ///     while a BG task is already running).
    ///   * `claimNextPending` atomically transitions one item from `.pending`
    ///     to `.uploading` so even the rare case of two drains in different
    ///     processes (main app + share extension) can't grab the same item.
    public func drainUploadQueue() async {
        guard await drainLock.tryAcquire() else {
            print("[BGSync] drainUploadQueue: another drain already running, skipping")
            return
        }
        await drainLoop()
        await drainLock.release()
    }

    /// Called when the app returns to the foreground. Items that were aborted
    /// mid-upload by background suspension show up as `.failed` with a
    /// transient `URLError` message; we requeue those so the user doesn't see
    /// ghost failures on every app re-open, then re-run the full pipeline.
    ///
    /// Re-running the whole pipeline (not just a queue drain) is what makes an
    /// interrupted manual sync continue on its own: iOS freezes the process a
    /// few seconds after backgrounding, so a manually started sync stops
    /// mid-scan and — unless the phone happens to be charging/idle when iOS
    /// decides to run the BGProcessingTask — never resumes. It also runs the
    /// download (bisync) half, which otherwise only ever ran from that rarely
    /// scheduled background task, so server-side album additions never reached
    /// the device after a manual sync. The upload watermark and the
    /// `/photos/index` ETag keep this cheap when nothing changed.
    public func handleForegroundResume() {
        Task {
            await UploadQueue.shared.requeueTransientFailures()
            try? await runFullSync()
        }
    }

    /// Runs the complete sync pipeline used by every trigger — the manual
    /// button, foreground resume and the background task: drain the upload
    /// queue, run the upload-side library sync, then the download-side (bisync)
    /// sync. Guarded by `pipelineLock` so overlapping triggers no-op instead of
    /// running two pipelines at once. Throws the first pipeline error so the
    /// manual UI can surface it; the auto-continue callers ignore it.
    ///
    /// Wrapped in a `beginBackgroundTask` assertion so a manual trigger that
    /// gets backgrounded (app not suspended-and-resumed, but actually pushed to
    /// the background without being plugged in) gets real extra execution time
    /// from the OS instead of being frozen within a fraction of a second. A
    /// plain `Task` with no such assertion gets essentially no background
    /// runtime, so a manual sync of any real size could never make it past its
    /// first checkpoint before being suspended (and, if the OS reclaims memory
    /// before the user reopens the app, jetsam-killed — losing all in-memory
    /// progress and forcing a scan restart). The expiration handler cancels the
    /// inner work cooperatively (`Task.checkCancellation()` checkpoints
    /// throughout the pipeline) so it can unwind and persist whatever
    /// checkpointed progress it already made instead of being killed mid-step.
    public func runFullSync() async throws {
        // Add trip photos the app hasn't seen yet to the trip album BEFORE the
        // upload scan, so they are enumerated and uploaded in this same run
        // (Trip Mode Etappe 1c). This covers photos taken with the Camera app
        // while F4mil Photos was suspended — the library-change observer never
        // sees those — and it also finishes ended trips up to their `endedAt`.
        //
        // Deliberately OUTSIDE the pipeline lock: the pass is cheap, local and
        // idempotent, whereas the lock's job is to keep two upload/download
        // pipelines apart. Running it inside meant every trigger that found the
        // lock taken (cold-launch task and foreground resume routinely race)
        // skipped the catch-up entirely, so the photos missed the scan that was
        // running right then and waited for the next cycle.
        await TripStore.shared.runAutoAddPass()

        // Trip suggestions (docs/ios-trip-mode.md §9). Both are cheap, local
        // and idempotent, and both belong here rather than on a timer of their
        // own: this method already runs on every occasion the app is awake
        // (open, foreground resume, background task), which is exactly when a
        // suggestion can be evaluated at all.
        //
        // The end suggestion in particular *must* be re-evaluated here and not
        // only from location updates: significant-change updates are driven by
        // movement, so a device parked at home stops producing them — which is
        // precisely the state the suggestion is waiting for.
        await TripAutoEndMonitor.shared.evaluateNow()
        await TripAutoStartMonitor.shared.evaluate()

        guard await pipelineLock.tryAcquire() else {
            print("[BGSync] runFullSync: another pipeline already running, skipping")
            return
        }

        let work = Task {
            // Download BEFORE upload. A photo deleted on the server must be moved
            // to "F4mil Trash" (and removed from the local album) FIRST — before
            // the upload scan runs. Otherwise the upload sees the still-present
            // local copy in the album, re-uploads it, and resurrects the deleted
            // photo (it reappears in the album while a stray copy is left in the
            // trash). Applying server-side removals first closes that race for
            // every downloaded photo, independent of the round-trip tracking set.
            try await PhotoDownloadService.shared.sync()
            await drainUploadQueue()
            try await PhotoSyncService.shared.sync()
        }

        let taskGuard = BackgroundTaskGuard()
        let bgTaskID = await MainActor.run {
            UIApplication.shared.beginBackgroundTask(withName: "dev.fk-encore.F4milPhotos.manualSync") {
                // The OS expects the background-time assertion released
                // immediately when this fires, not once the cooperatively
                // cancelled pipeline eventually unwinds — waiting risks a
                // watchdog termination before `work` even notices it was
                // cancelled.
                work.cancel()
                Task { await taskGuard.endIfNeeded() }
            }
        }
        await taskGuard.begin(bgTaskID)

        do {
            try await work.value
        } catch {
            await taskGuard.endIfNeeded()
            await pipelineLock.release()
            throw error
        }
        await taskGuard.endIfNeeded()
        await pipelineLock.release()
        // A sync is what makes new similar-photo groups appear, so it is also
        // the moment to notice and say so (#968, proposal 5). Silent unless
        // the queue actually grew since the user was last told.
        await ReviewQueueNotifier.checkAndNotify()
    }

    /// Ends a `beginBackgroundTask` assertion exactly once, however many
    /// callers race to end it — the expiration handler and `runFullSync`'s
    /// normal completion path both try. Ending the same identifier twice is a
    /// documented crash, so this isn't optional bookkeeping.
    private actor BackgroundTaskGuard {
        private var identifier: UIBackgroundTaskIdentifier = .invalid
        private var ended = false

        func begin(_ id: UIBackgroundTaskIdentifier) {
            identifier = id
        }

        func endIfNeeded() async {
            guard !ended, identifier != .invalid else { return }
            ended = true
            let id = identifier
            await MainActor.run { UIApplication.shared.endBackgroundTask(id) }
        }
    }

    /// Whether the current network state permits uploading queue items.
    /// With "Nur WLAN" enabled, uploads require an active WiFi path; otherwise
    /// any satisfied path (incl. cellular) suffices. Both inputs are read fresh
    /// on every call — `PhotoSyncPreferences.wifiOnly` straight from
    /// UserDefaults and the live `NWPath` from `PhotoSyncService` — so a
    /// preference toggle or connectivity change takes effect immediately,
    /// including mid-drain.
    public static func networkAllowsUpload() async -> Bool {
        if PhotoSyncPreferences.wifiOnly {
            return await PhotoSyncService.shared.isWifiConnected
        }
        return await PhotoSyncService.shared.isNetworkAvailable
    }

    /// The inner work of `drainUploadQueue`, factored out so the lock can be
    /// released exactly once at the call site (no defer-with-Task indirection).
    private func drainLoop() async {
        // Respect the WiFi-only preference (#653).
        guard await Self.networkAllowsUpload() else { return }

        await UploadQueue.shared.load()

        // Process items one at a time via claim → upload → mark. The claim
        // step is the concurrency boundary; from this point on the item is
        // invisible to other `pendingItems()` callers.
        while let claimed = await UploadQueue.shared.claimNextPending() {
            // Re-evaluate the network precondition before every item. The guard
            // at the top only covers the *start* of the drain; without this
            // re-check, toggling "Nur WLAN" back on (or dropping off WiFi)
            // mid-drain would let the loop barrel through all queued items over
            // cellular. Put the claimed item back as pending so it resumes once
            // WiFi returns.
            guard await Self.networkAllowsUpload() else {
                await UploadQueue.shared.markPending(id: claimed.id)
                break
            }

            // Cooperate with task cancellation (app suspension, BG-task
            // expiry). Put the item back so the next foreground wake-up
            // retries it instead of marking it as failed.
            if Task.isCancelled {
                await UploadQueue.shared.markPending(id: claimed.id)
                break
            }

            // Proactively refresh the access token before it expires during long
            // upload sessions. Checks the JWT exp claim; only hits the network when
            // expiry is < 2 minutes away (issue #625).
            await APIClient.shared.ensureFreshToken()

            // The Share Extension uploads with isFavorite = false and often
            // without a PHAsset identifier (iOS hands it only file bytes).
            // Recover the identifier by matching the photo back to the library,
            // then re-read the favourite/caption — both need the main app's
            // full Photos access. Skipped when the photo is not in the library
            // (shared from another app).
            let identified = await recoverAssetIdentifierIfMissing(claimed)
            let item = refreshMetadataFromLibrary(identified)
            let localId = item.assetLocalIdentifier ?? ""

            let outcome = await uploadSingleItem(item, localId: localId)
            switch outcome {
            case .succeeded(let photoId):
                if !localId.isEmpty {
                    PhotoSyncPreferences.saveSyncedStateEntry(
                        localId: localId,
                        imageDataHash: item.imageDataHash,
                        fullHash: item.fullHash
                    )
                    PhotoSyncPreferences.recordUploadedPhoto(
                        serverPhotoId: photoId,
                        localIdentifier: localId
                    )
                }
                for albumId in item.targetAlbumIds {
                    struct Body: Encodable { let albumId: Int; let photoId: Int }
                    struct Resp: Decodable { let success: Bool }
                    _ = try? await APIClient.shared.post(
                        "/albums/photos",
                        body: Body(albumId: albumId, photoId: photoId)
                    ) as Resp
                }
                await UploadQueue.shared.markDone(id: item.id)
                recordSuccessfulUpload(for: item)

            case .cancelled:
                await UploadQueue.shared.markPending(id: item.id)
                return  // Stop the whole drain; foreground re-entry will resume.

            case .failed(let error):
                await UploadQueue.shared.markFailed(id: item.id, error: error)
            }
        }
        await UploadQueue.shared.purgeDone()
    }

    /// Outcome of uploading a single queue item. `cancelled` is distinct from
    /// `failed` so the drain loop can pause cleanly when the app is suspended
    /// without marking valid items as permanently failed.
    private enum UploadOutcome {
        case succeeded(photoId: Int)
        case cancelled
        case failed(String)
    }

    /// Updates the user-visible "Letzter Upload" timestamp whenever a queue item
    /// is successfully uploaded.
    ///
    /// It deliberately does NOT touch the per-album sync watermark. The watermark
    /// is a *creationDate* value used by `buildFetchOptions` as
    /// `creationDate > watermark`. Advancing it here to `Date()` (wall-clock now)
    /// poisoned it: after the very first successful upload it jumped to "now", so
    /// the next enumeration matched nothing (`creationDate > now`) and the sync
    /// reported "finished" while hundreds of assets — those whose iCloud original
    /// was not yet downloaded and thus failed to hash — were never uploaded and
    /// could never be re-queued. The watermark is owned solely by
    /// `PhotoSyncService.advanceWatermarksForProcessed`, which advances it by the
    /// processed assets' real `creationDate` and never past an asset it could not
    /// process this run.
    private func recordSuccessfulUpload(for item: UploadQueueItem) {
        PhotoSyncPreferences.lastSyncDate = Date()
    }

    /// Performs the actual HTTP upload for one queue item, returning a
    /// classified outcome. The metadata-only fast path is tried first when the
    /// pixels are known to be unchanged.
    private func uploadSingleItem(_ item: UploadQueueItem, localId: String) async -> UploadOutcome {
        // Metadata-only fast path: if we have a synced state entry with the same
        // imageDataHash, the pixels haven't changed — skip re-uploading the bytes.
        if !localId.isEmpty,
           let syncedEntry = PhotoSyncPreferences.loadSyncedEntry(localId: localId),
           syncedEntry.imageDataHash == item.imageDataHash {
            do {
                let result = try await APIClient.shared.syncPhotoMetadata(
                    imageDataHash: item.imageDataHash,
                    fullHash: item.fullHash,
                    caption: item.caption,
                    isFavorite: item.isFavorite,
                    capturedAtString: item.capturedAtString,
                    assetLocalId: localId
                )
                if case .updated(let photoId) = result {
                    return .succeeded(photoId: photoId)
                }
                // .notFound → server doesn't recognise the photo; fall through.
            } catch {
                if Self.isCancellationError(error) { return .cancelled }
                // Other errors → fall through to full upload below.
            }
        }

        let data: Data
        let mimeType: String
        // PhotoKit stores the GPS coordinate on the PHAsset itself, separate
        // from the file's EXIF. Reading it here (instead of relying on the
        // resource bytes carrying it) works around iOS returning EXIF-stripped
        // bytes for background `PHAssetResource.requestData` calls — GPS still
        // reaches the server via the X-GPS-Lat/Lng headers below. Falls back to
        // the persisted item values (set by the Share Extension) when no
        // PHAsset is reachable, e.g. for a photo shared from another app.
        let liveLocation: CLLocation? = !localId.isEmpty
            ? PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil).firstObject?.location
            : nil
        let uploadLatitude = liveLocation?.coordinate.latitude ?? item.latitude
        let uploadLongitude = liveLocation?.coordinate.longitude ?? item.longitude

        if let tempURL = item.tempFileURL, let tempData = try? Data(contentsOf: tempURL) {
            data = tempData
            mimeType = item.mimeType
        } else if !localId.isEmpty,
                  let asset = PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil).firstObject,
                  let (assetData, assetMime) = try? await PhotoSyncService.loadAssetData(asset) {
            data = assetData
            mimeType = assetMime
        } else {
            return .failed("Bilddaten nicht ladbar (Asset nicht in Mediathek?)")
        }

        do {
            let result = try await APIClient.shared.uploadPhoto(
                data: data,
                filename: item.filename,
                mimeType: mimeType,
                imageDataHash: item.imageDataHash,
                fullHash: item.fullHash,
                caption: item.caption,
                isFavorite: item.isFavorite,
                capturedAtString: item.capturedAtString,
                assetLocalId: localId,
                latitude: uploadLatitude,
                longitude: uploadLongitude
            )
            return .succeeded(photoId: result.photoId)
        } catch APIError.duplicatePhoto(let existingId) {
            // Server reports duplicate. Treat as success so we don't keep
            // retrying — the dedup outcome is the same as a fresh insert.
            //
            // A 409 without an id used to be reported as photoId 0, which then
            // made the album-add below post `photoId: 0` and fail silently: the
            // photo counted as synced but never appeared in the target album.
            // Resolve the real id via the hash instead, and only give up when
            // that fails too.
            if let existingId, existingId > 0 { return .succeeded(photoId: existingId) }
            if let resolved = try? await APIClient.shared.syncCheck(hashes: [item.fullHash])[item.fullHash],
               resolved > 0 {
                return .succeeded(photoId: resolved)
            }
            return .failed("Duplikat ohne Foto-ID — Album-Zuordnung nicht möglich")
        } catch {
            if Self.isCancellationError(error) { return .cancelled }
            return .failed(error.localizedDescription)
        }
    }

    /// Recognises `URLSession`/`Task` cancellations and offline-network errors
    /// so we can re-queue instead of mark-as-failed when the app is suspended
    /// or the network briefly drops.
    private static func isCancellationError(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain {
            switch ns.code {
            case NSURLErrorCancelled,
                 NSURLErrorNetworkConnectionLost,
                 NSURLErrorNotConnectedToInternet,
                 NSURLErrorTimedOut:
                return true
            default:
                return false
            }
        }
        return false
    }

    // MARK: - Task handler

    private func handle(_ task: BGProcessingTask) {
        print("[BGSync] Task handler invoked")

        let work = Task {
            var success = true
            do {
                try await runFullSync()
            } catch {
                success = false
            }
            // Completed exactly once, and only after the pipeline has actually
            // stopped (Apple's recommended pattern: the expiration handler just
            // cancels; the work acknowledges). A cancelled run reports failure
            // so the system's heuristics don't treat it as a full run.
            task.setTaskCompleted(success: success && !Task.isCancelled)
            scheduleNextSyncIfNeeded()
        }

        task.expirationHandler = {
            // Reschedule FIRST: if the process gets suspended before the work
            // task acknowledges the cancellation, the follow-up run must
            // already be booked. scheduleNextSyncIfNeeded() is idempotent.
            self.scheduleNextSyncIfNeeded()
            work.cancel()
        }
    }

    // MARK: - Helpers

    private func percentEncodeHeaderValue(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.formUnion(.init(charactersIn: "-_.~!*'()"))
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}
