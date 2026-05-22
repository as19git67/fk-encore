import BackgroundTasks
import Foundation
import ImageIO
import Photos

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

    // MARK: - Registration (call once at launch)

    public func register() {
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
    }

    // MARK: - Scheduling

    /// Schedule the next sync run. Cancels the request if both upload and download are disabled.
    public func scheduleNextSyncIfNeeded() {
        guard PhotoSyncPreferences.syncEnabled || DownloadSyncPreferences.downloadEnabled else {
            BGTaskScheduler.shared.cancel(
                taskRequestWithIdentifier: PhotoSyncPreferences.taskIdentifier
            )
            return
        }

        let request = BGProcessingTaskRequest(identifier: PhotoSyncPreferences.taskIdentifier)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)

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
            enqueuePHBackgroundJob(item)
        } else {
            Task { await UploadQueue.shared.enqueue(item) }
        }
    }

    @available(iOS 26.1, *)
    private func enqueuePHBackgroundJob(_ item: UploadQueueItem) {
        guard let resource = item.assetLocalIdentifier.flatMap({ localId in
            PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil).firstObject
                .flatMap { PHAssetResource.assetResources(for: $0).first(where: { $0.type == .photo }) }
        }) else {
            // No PHAssetResource available (e.g. item came from Share Extension with file data only).
            // Fall back to UploadQueue for foreground processing.
            Task { await UploadQueue.shared.enqueue(item) }
            return
        }

        guard let baseURL = URL(string: SharedStorage.defaults.string(forKey: SharedStorage.serverURLKey) ?? ""),
              let token = KeychainHelper.loadString(forKey: "auth_token"),
              !token.isEmpty else {
            Task { await UploadQueue.shared.enqueue(item) }
            return
        }

        var request = URLRequest(url: baseURL.appendingPathComponent("/photos"))
        request.httpMethod = "POST"
        request.setValue(item.mimeType, forHTTPHeaderField: "Content-Type")
        request.setValue(percentEncodeHeaderValue(item.filename), forHTTPHeaderField: "X-File-Name")
        request.setValue(item.imageDataHash, forHTTPHeaderField: "X-Image-Data-Hash")
        request.setValue(item.fullHash, forHTTPHeaderField: "X-Full-Hash")
        request.setValue(percentEncodeHeaderValue(item.caption), forHTTPHeaderField: "X-Description")
        request.setValue(item.isFavorite ? "true" : "false", forHTTPHeaderField: "X-Is-Favorite")
        request.setValue(item.capturedAtString, forHTTPHeaderField: "X-Captured-At")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        do {
            try PHPhotoLibrary.shared().performChangesAndWait {
                PHAssetResourceUploadJobChangeRequest.createJob(destination: request, resource: resource)
            }
        } catch {
            print("[BGSync] PHAssetResourceUploadJobChangeRequest failed: \(error) — falling back to UploadQueue")
            Task { await UploadQueue.shared.enqueue(item) }
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
        guard let source = CGImageSourceCreateWithURL(item.tempFileURL as CFURL, nil),
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
    public func drainUploadQueue() async {
        await UploadQueue.shared.load()
        let pending = await UploadQueue.shared.pendingItems()
        guard !pending.isEmpty else { return }

        for item in pending {
            // The Share Extension uploads with isFavorite = false and often
            // without a PHAsset identifier (iOS hands it only file bytes).
            // Recover the identifier by matching the photo back to the library,
            // then re-read the favourite/caption — both need the main app's
            // full Photos access. Skipped when the photo is not in the library
            // (shared from another app).
            let identified = await recoverAssetIdentifierIfMissing(item)
            let item = refreshMetadataFromLibrary(identified)
            let localId = item.assetLocalIdentifier ?? ""

            // Metadata-only fast path: if we have a synced state entry with the same
            // imageDataHash, the pixels haven't changed — skip re-uploading the bytes.
            if !localId.isEmpty {
                let syncedEntry = PhotoSyncPreferences.loadSyncedEntry(localId: localId)
                if let syncedEntry, syncedEntry.imageDataHash == item.imageDataHash {
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
                            PhotoSyncPreferences.saveSyncedStateEntry(
                                localId: localId,
                                imageDataHash: item.imageDataHash,
                                fullHash: item.fullHash
                            )
                            PhotoSyncPreferences.recordUploadedPhoto(serverPhotoId: photoId, localIdentifier: localId)
                            for albumId in item.targetAlbumIds {
                                struct Body: Encodable { let albumId: Int; let photoId: Int }
                                struct Resp: Decodable { let success: Bool }
                                _ = try? await APIClient.shared.post("/albums/photos", body: Body(albumId: albumId, photoId: photoId)) as Resp
                            }
                            await UploadQueue.shared.markDone(id: item.id)
                            continue
                        }
                    } catch {
                        // Fall through to full upload
                    }
                }
            }

            guard let data = try? Data(contentsOf: item.tempFileURL) else {
                await UploadQueue.shared.markFailed(id: item.id)
                continue
            }
            do {
                let result = try await APIClient.shared.uploadPhoto(
                    data: data,
                    filename: item.filename,
                    mimeType: item.mimeType,
                    imageDataHash: item.imageDataHash,
                    fullHash: item.fullHash,
                    caption: item.caption,
                    isFavorite: item.isFavorite,
                    capturedAtString: item.capturedAtString,
                    assetLocalId: localId
                )
                PhotoSyncPreferences.saveSyncedStateEntry(
                    localId: localId,
                    imageDataHash: item.imageDataHash,
                    fullHash: item.fullHash
                )
                PhotoSyncPreferences.recordUploadedPhoto(
                    serverPhotoId: result.photoId,
                    localIdentifier: localId
                )
                for albumId in item.targetAlbumIds {
                    struct Body: Encodable { let albumId: Int; let photoId: Int }
                    struct Resp: Decodable { let success: Bool }
                    _ = try? await APIClient.shared.post(
                        "/albums/photos",
                        body: Body(albumId: albumId, photoId: result.photoId)
                    ) as Resp
                }
                await UploadQueue.shared.markDone(id: item.id)
            } catch APIError.duplicatePhoto(let existingId) {
                if let existingId {
                    PhotoSyncPreferences.saveSyncedStateEntry(
                        localId: localId,
                        imageDataHash: item.imageDataHash,
                        fullHash: item.fullHash
                    )
                    PhotoSyncPreferences.recordUploadedPhoto(
                        serverPhotoId: existingId,
                        localIdentifier: localId
                    )
                }
                await UploadQueue.shared.markDone(id: item.id)
            } catch {
                await UploadQueue.shared.markFailed(id: item.id)
            }
        }
    }

    // MARK: - Task handler

    private func handle(_ task: BGProcessingTask) {
        print("[BGSync] Task handler invoked")
        scheduleNextSyncIfNeeded()

        let work = Task {
            do {
                // Drain the upload queue first (items from Share Extension, etc.)
                await drainUploadQueue()
                try await PhotoSyncService.shared.sync()
                try await PhotoDownloadService.shared.sync()
                task.setTaskCompleted(success: true)
            } catch {
                task.setTaskCompleted(success: false)
            }
        }

        task.expirationHandler = {
            work.cancel()
            task.setTaskCompleted(success: false)
        }
    }

    // MARK: - Helpers

    private func percentEncodeHeaderValue(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.formUnion(.init(charactersIn: "-_.~!*'()"))
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}
