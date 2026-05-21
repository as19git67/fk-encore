import Foundation

/// A single item waiting to be uploaded to the server.
public struct UploadQueueItem: Codable, Identifiable, Sendable {
    public let id: UUID
    /// The local PHAsset identifier (if the item came from the Photos library).
    public let assetLocalIdentifier: String?
    /// Path to the temporary image file inside the App Group container.
    public let tempFileURL: URL
    public let filename: String
    public let mimeType: String
    public let imageDataHash: String
    public let fullHash: String
    public let caption: String
    public let isFavorite: Bool
    public let capturedAtString: String
    public let targetAlbumIds: [Int]
    public var status: Status
    public var retryCount: Int

    public enum Status: String, Codable {
        case pending
        case uploading
        case done
        case failed
    }

    public init(
        id: UUID = UUID(),
        assetLocalIdentifier: String? = nil,
        tempFileURL: URL,
        filename: String,
        mimeType: String,
        imageDataHash: String,
        fullHash: String,
        caption: String,
        isFavorite: Bool,
        capturedAtString: String,
        targetAlbumIds: [Int] = [],
        status: Status = .pending,
        retryCount: Int = 0
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
        self.status = status
        self.retryCount = retryCount
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
    }

    func enqueue(_ item: UploadQueueItem) {
        items.append(item)
        persist()
    }

    func pendingItems() -> [UploadQueueItem] {
        items.filter { $0.status == .pending || $0.status == .uploading }
    }

    func markDone(id: UUID) {
        guard let idx = items.firstIndex(where: { $0.id == id }) else { return }
        let fileURL = items[idx].tempFileURL
        items[idx].status = .done
        persist()
        try? FileManager.default.removeItem(at: fileURL)
    }

    func markFailed(id: UUID) {
        guard let idx = items.firstIndex(where: { $0.id == id }) else { return }
        items[idx].status = .failed
        items[idx].retryCount += 1
        persist()
    }

    func remove(id: UUID) {
        guard let idx = items.firstIndex(where: { $0.id == id }) else { return }
        let fileURL = items[idx].tempFileURL
        items.remove(at: idx)
        persist()
        try? FileManager.default.removeItem(at: fileURL)
    }

    /// Removes all pending/failed items and their temp files.
    func cancelAll() {
        let toRemove = items.filter { $0.status == .pending || $0.status == .failed }
        for item in toRemove {
            try? FileManager.default.removeItem(at: item.tempFileURL)
        }
        items.removeAll { $0.status == .pending || $0.status == .failed }
        persist()
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

    // MARK: - Persistence

    private func persist() {
        guard let data = try? JSONEncoder().encode(items) else { return }
        try? data.write(to: queueFileURL, options: .atomic)
    }

    // MARK: - Temp file helpers

    /// Saves image data to a new temp file in the App Group container and returns the URL.
    func saveTempFile(data: Data, filename: String) throws -> URL {
        let dest = tempDirectory.appendingPathComponent("\(UUID().uuidString)_\(filename)")
        try data.write(to: dest, options: .atomic)
        return dest
    }
}
