import Foundation
import Observation

/// A single item waiting to be uploaded to the server.
public struct UploadQueueItem: Codable, Identifiable, Sendable {
    public let id: UUID
    /// The local PHAsset identifier (if the item came from the Photos library).
    public let assetLocalIdentifier: String?
    /// Path to the temporary image file inside the App Group container.
    /// Nil for library-sync items that load directly from PHAsset.
    public let tempFileURL: URL?
    public let filename: String
    public let mimeType: String
    public let imageDataHash: String
    public let fullHash: String
    public let caption: String
    public let isFavorite: Bool
    public let capturedAtString: String
    public let targetAlbumIds: [Int]
    /// The iOS PHAssetCollection.localIdentifier this item was enqueued from.
    /// Used to advance per-album sync watermarks on successful upload. Nil for
    /// Share-Extension items and the "entire library" sentinel.
    public let sourceIosAlbumId: String?
    public var status: Status
    public var retryCount: Int
    public var lastError: String?

    public enum Status: String, Codable {
        case pending
        case uploading
        case done
        case failed
    }

    public init(
        id: UUID = UUID(),
        assetLocalIdentifier: String? = nil,
        tempFileURL: URL? = nil,
        filename: String,
        mimeType: String,
        imageDataHash: String,
        fullHash: String,
        caption: String,
        isFavorite: Bool,
        capturedAtString: String,
        targetAlbumIds: [Int] = [],
        sourceIosAlbumId: String? = nil,
        status: Status = .pending,
        retryCount: Int = 0,
        lastError: String? = nil
    ) {
        self.id = id
        self.assetLocalIdentifier = assetLocalIdentifier
        self.tempFileURL = tempFileURL
        self.filename = filename
        self.mimeType = mimeType
        self.imageDataHash = imageDataHash
        self.fullHash = fullHash
        self.caption = caption
        self.isFavorite = isFavorite
        self.capturedAtString = capturedAtString
        self.targetAlbumIds = targetAlbumIds
        self.sourceIosAlbumId = sourceIosAlbumId
        self.status = status
        self.retryCount = retryCount
        self.lastError = lastError
    }

    /// Returns a copy with the asset identifier replaced. Used when the main
    /// app recovers the `PHAsset` identifier of a Share-Extension item that was
    /// enqueued without one.
    public func withAssetLocalIdentifier(_ identifier: String) -> UploadQueueItem {
        UploadQueueItem(
            id: id,
            assetLocalIdentifier: identifier,
            tempFileURL: tempFileURL,
            filename: filename,
            mimeType: mimeType,
            imageDataHash: imageDataHash,
            fullHash: fullHash,
            caption: caption,
            isFavorite: isFavorite,
            capturedAtString: capturedAtString,
            targetAlbumIds: targetAlbumIds,
            sourceIosAlbumId: sourceIosAlbumId,
            status: status,
            retryCount: retryCount,
            lastError: lastError
        )
    }
}

/// Persistent upload queue shared between the main app and the Share Extension via the App Group container.
///
/// The queue is stored as a JSON file in the App Group container so it survives app restarts
/// and is accessible to both the main app and the VivantyShare extension.
actor UploadQueue {
    static let shared = UploadQueue()

    private static let appGroupID = "group.dev.fk-encore.VivantyPhotos"
    private static let queueFilename = "upload_queue.json"
    private static let tempDirName = "pending_uploads"

    private(set) var items: [UploadQueueItem] = []

    private lazy var queueFileURL: URL = {
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: Self.appGroupID
        ) else {
            return FileManager.default.temporaryDirectory.appendingPathComponent(Self.queueFilename)
        }
        return container.appendingPathComponent(Self.queueFilename)
    }()

    lazy var tempDirectory: URL = {
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: Self.appGroupID
        ) else {
            return FileManager.default.temporaryDirectory.appendingPathComponent(Self.tempDirName)
        }
        let dir = container.appendingPathComponent(Self.tempDirName, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    private init() {}

    // MARK: - Queue management

    func load() {
        guard let data = try? Data(contentsOf: queueFileURL),
              let loaded = try? JSONDecoder().decode([UploadQueueItem].self, from: data) else { return }
        items = loaded
        notifyObservers()
    }

    func enqueue(_ item: UploadQueueItem) {
        items.append(item)
        persist()
    }

    /// Pending items not yet claimed by a drain run. Items in `.uploading`
    /// are intentionally excluded so two concurrent drains don't pick up the
    /// same work — exactly the race that caused duplicate server-side photos.
    func pendingItems() -> [UploadQueueItem] {
        items.filter { $0.status == .pending }
    }

    /// Counts items still waiting or currently being uploaded. Used by the UI
    /// to decide whether to show the "in progress" affordance.
    func inFlightCount() -> Int {
        items.filter { $0.status == .pending || $0.status == .uploading }.count
    }

    /// Atomically transitions the next `.pending` item to `.uploading` and
    /// returns it. Returns nil when nothing is left to claim. The claim is the
    /// concurrency boundary — once an item is `.uploading`, other drain runs
    /// can't see it via `pendingItems()`.
    func claimNextPending() -> UploadQueueItem? {
        guard let idx = items.firstIndex(where: { $0.status == .pending }) else { return nil }
        items[idx].status = .uploading
        persist()
        return items[idx]
    }

    /// Reverts an item from `.uploading` back to `.pending`. Used when an
    /// upload was cancelled (app suspended mid-flight) so the next drain run
    /// picks it up instead of marking it as a permanent failure.
    func markPending(id: UUID) {
        guard let idx = items.firstIndex(where: { $0.id == id }) else { return }
        items[idx].status = .pending
        items[idx].lastError = nil
        persist()
    }

    /// Resets every `.failed` item whose last error looks transient (cancelled,
    /// timed out, offline) back to `.pending`. Called when the app returns to
    /// the foreground so background-suspension failures retry automatically
    /// instead of accumulating in the UI as "failed".
    func requeueTransientFailures() {
        var changed = false
        for idx in items.indices where items[idx].status == .failed {
            if Self.isTransientErrorMessage(items[idx].lastError) {
                items[idx].status = .pending
                items[idx].lastError = nil
                changed = true
            }
        }
        if changed { persist() }
    }

    /// Pattern-matches the localised `URLError` / `CancellationError` text so
    /// we don't need to thread typed errors through the persistence layer. The
    /// list is intentionally lenient — a false positive merely retries an upload.
    private static func isTransientErrorMessage(_ message: String?) -> Bool {
        guard let m = message?.lowercased(), !m.isEmpty else { return true }
        return m.contains("cancelled") || m.contains("canceled")
            || m.contains("offline") || m.contains("network connection was lost")
            || m.contains("timed out") || m.contains("timeout")
            || m.contains("could not connect") || m.contains("internet connection")
    }

    func markDone(id: UUID) {
        guard let idx = items.firstIndex(where: { $0.id == id }) else { return }
        if let fileURL = items[idx].tempFileURL {
            try? FileManager.default.removeItem(at: fileURL)
        }
        items[idx].status = .done
        persist()
    }

    func markFailed(id: UUID, error: String? = nil) {
        guard let idx = items.firstIndex(where: { $0.id == id }) else { return }
        items[idx].status = .failed
        items[idx].retryCount += 1
        items[idx].lastError = error
        persist()
    }

    func remove(id: UUID) {
        guard let idx = items.firstIndex(where: { $0.id == id }) else { return }
        if let fileURL = items[idx].tempFileURL {
            try? FileManager.default.removeItem(at: fileURL)
        }
        items.remove(at: idx)
        persist()
    }

    /// Removes all pending/failed items and their temp files.
    func cancelAll() {
        let toRemove = items.filter { $0.status == .pending || $0.status == .failed }
        for item in toRemove {
            if let url = item.tempFileURL { try? FileManager.default.removeItem(at: url) }
        }
        items.removeAll { $0.status == .pending || $0.status == .failed }
        persist()
    }

    func cancelPending() {
        let toRemove = items.filter { $0.status == .pending || $0.status == .uploading }
        for item in toRemove {
            if let url = item.tempFileURL { try? FileManager.default.removeItem(at: url) }
        }
        items.removeAll { $0.status == .pending || $0.status == .uploading }
        persist()
    }

    func removeAllFailed() {
        let toRemove = items.filter { $0.status == .failed }
        for item in toRemove {
            if let url = item.tempFileURL { try? FileManager.default.removeItem(at: url) }
        }
        items.removeAll { $0.status == .failed }
        persist()
    }

    func purgeDone() {
        let before = items.count
        items.removeAll { $0.status == .done }
        if items.count != before { persist() }
    }

    /// Resets uploading items back to pending (call on app launch after a crash).
    func resetStaleUploading() {
        var changed = false
        for idx in items.indices where items[idx].status == .uploading {
            items[idx].status = .pending
            changed = true
        }
        if changed { persist() }
    }

    var pendingCount: Int {
        items.filter { $0.status == .pending }.count
    }

    // MARK: - Observation

    private var continuations: [UUID: AsyncStream<[UploadQueueItem]>.Continuation] = [:]

    func observeChanges() -> AsyncStream<[UploadQueueItem]> {
        let (stream, continuation) = AsyncStream.makeStream(of: [UploadQueueItem].self)
        let id = UUID()
        continuations[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { await self?.removeContinuation(id: id) }
        }
        continuation.yield(items)
        return stream
    }

    private func removeContinuation(id: UUID) {
        continuations.removeValue(forKey: id)
    }

    private func notifyObservers() {
        for continuation in continuations.values {
            continuation.yield(items)
        }
    }

    // MARK: - Persistence

    private func persist() {
        guard let data = try? JSONEncoder().encode(items) else { return }
        try? data.write(to: queueFileURL, options: .atomic)
        notifyObservers()
    }

    // MARK: - Temp file helpers

    /// Saves image data to a new temp file in the App Group container and returns the URL.
    func saveTempFile(data: Data, filename: String) throws -> URL {
        let dest = tempDirectory.appendingPathComponent("\(UUID().uuidString)_\(filename)")
        try data.write(to: dest, options: .atomic)
        return dest
    }
}

// MARK: - Observable wrapper for SwiftUI

@Observable @MainActor
final class UploadQueueObserver {
    private(set) var items: [UploadQueueItem] = []
    nonisolated(unsafe) private var observeTask: Task<Void, Never>?

    deinit { observeTask?.cancel() }

    var pendingItems: [UploadQueueItem] {
        items.filter { $0.status == .pending || $0.status == .uploading }
    }

    var failedItems: [UploadQueueItem] {
        items.filter { $0.status == .failed }
    }

    var hasVisibleItems: Bool {
        !pendingItems.isEmpty || !failedItems.isEmpty
    }

    /// True when at least one item is currently being uploaded by a drain run.
    /// Used to show "wird hochgeladen" affordances even if the queue display
    /// otherwise hides claimed items.
    var hasActiveUpload: Bool {
        items.contains { $0.status == .uploading }
    }

    func startObserving() {
        guard observeTask == nil else { return }
        observeTask = Task {
            let stream = await UploadQueue.shared.observeChanges()
            for await snapshot in stream {
                self.items = snapshot
            }
        }
    }

    func stopObserving() {
        observeTask?.cancel()
        observeTask = nil
    }

    func cancelPending() {
        Task { await UploadQueue.shared.cancelPending() }
    }

    func removeAllFailed() {
        Task { await UploadQueue.shared.removeAllFailed() }
    }

    func remove(id: UUID) {
        Task { await UploadQueue.shared.remove(id: id) }
    }
}
