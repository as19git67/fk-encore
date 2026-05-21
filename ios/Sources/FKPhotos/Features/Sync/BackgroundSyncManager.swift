import BackgroundTasks
import Foundation
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

    // MARK: - Foreground queue drain (iOS < 26.1 / BGProcessingTask fallback)

    /// Drains pending UploadQueue items using the main app's network stack.
    /// Called from the BGProcessingTask handler and from the app foreground.
    public func drainUploadQueue() async {
        await UploadQueue.shared.load()
        let pending = await UploadQueue.shared.pendingItems()
        guard !pending.isEmpty else { return }

        for item in pending {
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
                    capturedAtString: item.capturedAtString
                )
                PhotoSyncPreferences.recordUploadedPhoto(
                    serverPhotoId: result.photoId,
                    localIdentifier: item.assetLocalIdentifier ?? ""
                )
                // Attach to target albums.
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
                    PhotoSyncPreferences.recordUploadedPhoto(
                        serverPhotoId: existingId,
                        localIdentifier: item.assetLocalIdentifier ?? ""
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
