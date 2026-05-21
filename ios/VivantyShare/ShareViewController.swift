import CryptoKit
import Foundation
import ImageIO
import Photos
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// MARK: - Extension entry point

class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let providers = (extensionContext?.inputItems as? [NSExtensionItem])?
            .flatMap { $0.attachments ?? [] } ?? []
        let root = ShareUploadView(
            extensionContext: extensionContext!,
            itemProviders: providers
        )
        let host = UIHostingController(rootView: root)
        addChild(host)
        view.addSubview(host.view)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        host.didMove(toParent: self)
    }
}

// MARK: - SwiftUI view

struct ShareUploadView: View {
    let extensionContext: NSExtensionContext
    let itemProviders: [NSItemProvider]

    @State private var albums: [ShareAlbum] = []
    @State private var selectedAlbumIds: Set<Int> = Set(ShareConfig.recentAlbumIds)
    @State private var searchText = ""
    @State private var isLoadingAlbums = true

    @State private var showNewAlbum = false
    @State private var newAlbumName = ""
    @State private var isCreatingAlbum = false
    @State private var isUploading = false

    private var filteredAlbums: [ShareAlbum] {
        let base = searchText.isEmpty
            ? albums
            : albums.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
        return base.sorted { a, b in
            let aSelected = selectedAlbumIds.contains(a.id)
            let bSelected = selectedAlbumIds.contains(b.id)
            if aSelected != bSelected { return aSelected }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }
    @State private var uploadProgress = 0
    @State private var totalToUpload = 0
    @State private var errorMessage: String?
    @State private var prevItemErrorMessage: String?
    @State private var isDone = false
    @State private var uploadTask: Task<Void, Never>? = nil
    @State private var previousPendingItems: [ShareUploadQueueWriter.PendingItem] = []

    var body: some View {
        NavigationStack {
            Group {
                if isLoadingAlbums {
                    ProgressView("Alben laden…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if isUploading || isDone {
                    uploadProgressView
                } else {
                    Form {
                        if !previousPendingItems.isEmpty {
                            Section {
                                HStack(spacing: 12) {
                                    Image(systemName: "clock.badge.exclamationmark")
                                        .foregroundStyle(.orange)
                                    Text("\(previousPendingItems.count) ausstehende Foto(s) aus vorherigem Upload werden mit hochgeladen.")
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                    Spacer()
                                    Button("Leeren") {
                                        for item in previousPendingItems {
                                            ShareUploadQueueWriter.markFailed(id: item.id)
                                        }
                                        previousPendingItems = []
                                    }
                                    .font(.footnote)
                                    .foregroundStyle(.red)
                                }
                            }
                        }
                        Section {
                            if albums.isEmpty {
                                Text("Keine Alben gefunden")
                                    .foregroundStyle(.secondary)
                            } else {
                                ForEach(filteredAlbums) { album in
                                    Button {
                                        if selectedAlbumIds.contains(album.id) {
                                            selectedAlbumIds.remove(album.id)
                                        } else {
                                            selectedAlbumIds.insert(album.id)
                                        }
                                    } label: {
                                        HStack {
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(album.name)
                                                    .foregroundStyle(.primary)
                                                Text("\(album.photoCount) Fotos")
                                                    .font(.caption)
                                                    .foregroundStyle(.secondary)
                                            }
                                            Spacer()
                                            if selectedAlbumIds.contains(album.id) {
                                                Image(systemName: "checkmark")
                                                    .foregroundStyle(Color.accentColor)
                                                    .fontWeight(.semibold)
                                            }
                                        }
                                    }
                                }
                            }
                        } header: {
                            Text("Album (optional)")
                        } footer: {
                            Text("Wenn kein Album gewählt, werden die Fotos ohne Album-Zuordnung hochgeladen.")
                        }

                        if let error = errorMessage {
                            Section {
                                Text(error)
                                    .foregroundStyle(.red)
                                    .font(.footnote)
                            }
                        }
                    }
                    .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always), prompt: "Album suchen")
                }
            }
            .navigationTitle("In Vivanty teilen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if isUploading {
                        Button("Abbrechen") { cancelUpload() }
                            .foregroundStyle(.red)
                    } else {
                        Button("Schließen") {
                            extensionContext.cancelRequest(withError: CancellationError())
                        }
                    }
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        newAlbumName = ""
                        showNewAlbum = true
                    } label: {
                        Image(systemName: "folder.badge.plus")
                    }
                    .disabled(isUploading || isLoadingAlbums)
                    .opacity(isUploading ? 0 : 1)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isUploading {
                        Button("Schließen") { closeWithBackground() }
                    } else if !isDone {
                        Button("Hochladen") {
                            let task = Task { await performUpload() }
                            uploadTask = task
                        }
                    }
                }
            }
        }
        .alert("Neues Album", isPresented: $showNewAlbum) {
            TextField("Albumname", text: $newAlbumName)
            Button("Erstellen") {
                let name = newAlbumName.trimmingCharacters(in: .whitespaces)
                guard !name.isEmpty else { return }
                Task { await createAlbum(name: name) }
            }
            .disabled(newAlbumName.trimmingCharacters(in: .whitespaces).isEmpty)
            Button("Abbrechen", role: .cancel) {}
        }
        .task { await loadAlbums() }
        .onChange(of: isDone) { _, done in
            guard done else { return }
            Task {
                try? await Task.sleep(for: .seconds(0.8))
                extensionContext.completeRequest(returningItems: nil)
            }
        }
    }

    // MARK: - Upload progress view

    private var uploadProgressView: some View {
        VStack(spacing: 20) {
            Spacer()
            if isDone {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 56))
                    .foregroundStyle(.green)
                Text(totalToUpload == 1
                     ? "1 Foto hochgeladen"
                     : "\(totalToUpload) Fotos hochgeladen")
                    .font(.headline)
            } else {
                ProgressView(value: Double(uploadProgress), total: Double(max(1, totalToUpload)))
                    .padding(.horizontal, 32)
                Text("\(uploadProgress) von \(totalToUpload) hochgeladen")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                if let error = errorMessage {
                    Text(error)
                        .foregroundStyle(.orange)
                        .font(.caption)
                        .padding(.horizontal)
                        .multilineTextAlignment(.center)
                }
                if let prevErr = prevItemErrorMessage, errorMessage == nil {
                    Text("Ältere ausstehende Fotos konnten nicht übertragen werden – die Hauptapp holt sie nach.")
                        .foregroundStyle(.secondary)
                        .font(.caption2)
                        .padding(.horizontal)
                        .multilineTextAlignment(.center)
                    let _ = prevErr // suppress unused warning
                }
            }
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Cancel / Close

    /// Cancels all pending uploads and dismisses the extension.
    private func cancelUpload() {
        uploadTask?.cancel()
        uploadTask = nil
        ShareUploadQueueWriter.cancelAll()
        isUploading = false
        extensionContext.cancelRequest(withError: CancellationError())
    }

    /// Stops the in-extension upload but keeps queue items so the main app can drain them.
    private func closeWithBackground() {
        uploadTask?.cancel()
        uploadTask = nil
        isUploading = false
        extensionContext.completeRequest(returningItems: nil)
    }

    // MARK: - Album loading

    private func loadAlbums() async {
        let previous = ShareUploadQueueWriter.pendingItems()
        previousPendingItems = previous
        if !previous.isEmpty {
            totalToUpload = previous.count
        }

        do {
            let data = try await ShareAPIClient.get(path: "/albums")
            struct AlbumEntry: Decodable { let id: Int; let name: String; let photo_count: Int }
            struct Response: Decodable { let albums: [AlbumEntry] }
            let decoded = try JSONDecoder().decode(Response.self, from: data)
            albums = decoded.albums
                .map { ShareAlbum(id: $0.id, name: $0.name, photoCount: $0.photo_count) }
                .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        } catch let e as ShareAPIError {
            errorMessage = e.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoadingAlbums = false
    }

    // MARK: - Album creation

    private func createAlbum(name: String) async {
        isCreatingAlbum = true
        defer { isCreatingAlbum = false }
        do {
            let album = try await ShareAPIClient.createAlbum(name: name)
            albums.append(album)
            albums.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            selectedAlbumIds.insert(album.id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Upload

    private func performUpload() async {
        isUploading = true
        errorMessage = nil

        // Load new items from providers.
        var newItems: [SharePhotoItem] = []
        for provider in itemProviders {
            if let item = await loadPhotoItem(from: provider) {
                newItems.append(item)
            }
        }

        let prevItems = previousPendingItems
        guard !newItems.isEmpty || !prevItems.isEmpty else {
            errorMessage = "Kein unterstütztes Bild gefunden."
            isUploading = false
            return
        }

        totalToUpload = prevItems.count + newItems.count
        uploadProgress = 0

        ShareConfig.saveRecentAlbumIds(Array(selectedAlbumIds))
        let targetAlbumIds = Array(selectedAlbumIds)

        var uploadedIds: [Int] = []
        // Tracks imageDataHashes that were successfully uploaded via prevItems so that
        // the same photo appearing in newItems (same session, queue not yet cleared) is
        // not uploaded a second time.
        var uploadedPrevHashes = Set<String>()

        // 1. Upload previously queued items (surviving from a prior extension session).
        for prev in prevItems {
            guard !Task.isCancelled else { break }
            guard let data = try? Data(contentsOf: prev.tempFileURL) else {
                ShareUploadQueueWriter.markFailed(id: prev.id)
                uploadProgress += 1
                continue
            }
            let item = SharePhotoItem(
                data: data, filename: prev.filename, mimeType: prev.mimeType,
                imageDataHash: prev.imageDataHash, fullHash: prev.fullHash,
                caption: prev.caption, isFavorite: prev.isFavorite,
                capturedAtString: prev.capturedAtString, assetLocalIdentifier: nil
            )
            do {
                let photoId = try await ShareAPIClient.uploadPhoto(item: item)
                uploadedIds.append(photoId)
                uploadedPrevHashes.insert(prev.imageDataHash)
                ShareUploadQueueWriter.markDone(id: prev.id)
                for albumId in prev.targetAlbumIds {
                    try? await ShareAPIClient.addPhotoToAlbum(photoId: photoId, albumId: albumId)
                }
            } catch ShareAPIError.duplicate(let existingId) {
                if let id = existingId { uploadedIds.append(id) }
                uploadedPrevHashes.insert(prev.imageDataHash)
                ShareUploadQueueWriter.markDone(id: prev.id)
            } catch {
                // Failures on prev items don't block auto-close — the main app retries them.
                prevItemErrorMessage = error.localizedDescription
                ShareUploadQueueWriter.markFailed(id: prev.id)
            }
            uploadProgress += 1
        }

        // 2. Enqueue new items so they survive if extension is closed mid-upload.
        var queueEntries: [ShareQueueEntry] = []
        for item in newItems {
            if let entry = ShareUploadQueueWriter.enqueue(item, albumIds: targetAlbumIds) {
                queueEntries.append(entry)
            }
        }

        // 3. Upload new items.
        for (index, item) in newItems.enumerated() {
            guard !Task.isCancelled else { break }
            // Skip if the same photo was already uploaded via prevItems in this session.
            if uploadedPrevHashes.contains(item.imageDataHash) {
                print("[Share Upload] skipping duplicate new item \(item.filename) (already uploaded via prevItems)")
                if index < queueEntries.count {
                    ShareUploadQueueWriter.markDone(id: queueEntries[index].id)
                }
                uploadProgress += 1
                continue
            }
            do {
                let photoId = try await ShareAPIClient.uploadPhoto(item: item)
                uploadedIds.append(photoId)
                if index < queueEntries.count {
                    ShareUploadQueueWriter.markDone(id: queueEntries[index].id)
                }
            } catch ShareAPIError.duplicate(let existingId) {
                if let id = existingId { uploadedIds.append(id) }
                if index < queueEntries.count {
                    ShareUploadQueueWriter.markDone(id: queueEntries[index].id)
                }
            } catch {
                errorMessage = error.localizedDescription
            }
            uploadProgress += 1
        }

        // 4. Add all uploaded photos to currently selected albums.
        for albumId in selectedAlbumIds {
            for photoId in uploadedIds {
                try? await ShareAPIClient.addPhotoToAlbum(photoId: photoId, albumId: albumId)
            }
        }

        // Auto-close only depends on new items succeeding; prev-item failures are
        // non-blocking (the main app's background sync will retry them).
        if errorMessage == nil && !Task.isCancelled { isDone = true }
        isUploading = false
    }

    // MARK: - Photo item loading

    private func loadPhotoItem(from provider: NSItemProvider) async -> SharePhotoItem? {
        // Try to get the PHAsset identifier (Photos.app share).
        let assetId = await loadAssetIdentifier(from: provider)

        // If we have a PHAsset, load original resource bytes for hash consistency.
        if let assetId,
           let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil).firstObject {
            if let item = await loadFromPhotoAsset(asset) { return item }
        }

        // Fall back to NSItemProvider bytes.
        let isFavorite = assetId.flatMap { PHAsset.fetchAssets(withLocalIdentifiers: [$0], options: nil).firstObject }?.isFavorite ?? false
        let capturedAt = assetId.flatMap { PHAsset.fetchAssets(withLocalIdentifiers: [$0], options: nil).firstObject }?.creationDate
        return await loadFromItemProvider(provider, isFavorite: isFavorite, capturedAt: capturedAt, assetId: assetId)
    }

    private func loadFromPhotoAsset(_ asset: PHAsset) async -> SharePhotoItem? {
        guard let resource = PHAssetResource.assetResources(for: asset)
            .first(where: { $0.type == .photo })
            ?? PHAssetResource.assetResources(for: asset).first(where: { $0.type == .fullSizePhoto })
        else { return nil }

        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true

        let result: (Data, String)? = await withCheckedContinuation { cont in
            var chunks: [Data] = []
            PHAssetResourceManager.default().requestData(for: resource, options: options) { chunk in
                chunks.append(chunk)
            } completionHandler: { error in
                guard error == nil else { cont.resume(returning: nil); return }
                let data = chunks.reduce(Data(), +)
                let mime = ShareHasher.mimeType(for: resource.uniformTypeIdentifier)
                cont.resume(returning: (data, mime))
            }
        }

        guard let (data, mimeType) = result else { return nil }

        let imageDataHash = ShareHasher.sha256Hex(data)
        let caption = ShareHasher.captionFromAsset(asset) ?? ""
        let isFavorite = asset.isFavorite
        let capturedAtString = ShareHasher.capturedAtString(for: asset, from: data)
        let fullHash = ShareHasher.fullHash(
            imageDataHash: imageDataHash,
            caption: caption,
            isFavorite: isFavorite,
            capturedAtString: capturedAtString
        )
        let filename = resource.originalFilename

        return SharePhotoItem(
            data: data,
            filename: filename,
            mimeType: mimeType,
            imageDataHash: imageDataHash,
            fullHash: fullHash,
            caption: caption,
            isFavorite: isFavorite,
            capturedAtString: capturedAtString,
            assetLocalIdentifier: asset.localIdentifier
        )
    }

    private func loadFromItemProvider(
        _ provider: NSItemProvider,
        isFavorite: Bool,
        capturedAt: Date?,
        assetId: String?
    ) async -> SharePhotoItem? {
        let candidates: [(String, String, String)] = [
            (UTType.heic.identifier, "photo.heic", "image/heic"),
            (UTType.jpeg.identifier, "photo.jpg",  "image/jpeg"),
            (UTType.png.identifier,  "photo.png",  "image/png"),
            (UTType.tiff.identifier, "photo.tiff", "image/tiff"),
            ("public.image",         "photo.jpg",  "image/jpeg"),
        ]
        for (uti, filename, mimeType) in candidates {
            guard provider.hasItemConformingToTypeIdentifier(uti) else { continue }
            let result: SharePhotoItem? = await withCheckedContinuation { cont in
                provider.loadDataRepresentation(forTypeIdentifier: uti) { data, _ in
                    guard let data else { cont.resume(returning: nil); return }
                    let imageDataHash = ShareHasher.sha256Hex(data)
                    let caption = ShareHasher.extractIPTCCaption(from: data) ?? ""
                    let capturedAtString = ShareHasher.capturedAtStringFromData(capturedAt: capturedAt, imageData: data)
                    // When no PHAsset is available, read the favorite flag from XMP Rating in the
                    // image bytes (Photos.app writes Rating=5 for favorites on export).
                    let effectiveIsFavorite = isFavorite || ShareHasher.isFavoriteFromXMP(data)
                    let fullHash = ShareHasher.fullHash(
                        imageDataHash: imageDataHash,
                        caption: caption,
                        isFavorite: effectiveIsFavorite,
                        capturedAtString: capturedAtString
                    )
                    cont.resume(returning: SharePhotoItem(
                        data: data,
                        filename: filename,
                        mimeType: mimeType,
                        imageDataHash: imageDataHash,
                        fullHash: fullHash,
                        caption: caption,
                        isFavorite: effectiveIsFavorite,
                        capturedAtString: capturedAtString,
                        assetLocalIdentifier: assetId
                    ))
                }
            }
            if let result { return result }
        }
        return nil
    }

    private func loadAssetIdentifier(from provider: NSItemProvider) async -> String? {
        for uti in ["com.apple.photos.asset", "com.apple.photos.asset-identifiers"] {
            guard provider.hasItemConformingToTypeIdentifier(uti) else { continue }
            let localId: String? = await withCheckedContinuation { cont in
                provider.loadItem(forTypeIdentifier: uti, options: nil) { item, _ in
                    if let url = item as? URL, url.scheme == "phasset" {
                        // phasset://<localIdentifier>
                        cont.resume(returning: url.host)
                    } else if let ids = item as? [String], let id = ids.first {
                        // Array of identifier strings
                        cont.resume(returning: id)
                    } else if let id = item as? String, !id.isEmpty {
                        // Plain string (simulator and some iOS versions)
                        cont.resume(returning: id)
                    } else {
                        print("[Share] loadAssetIdentifier: UTI=\(uti) returned unexpected type=\(type(of: item)), value=\(String(describing: item))")
                        cont.resume(returning: nil)
                    }
                }
            }
            if let localId {
                print("[Share] loadAssetIdentifier: resolved assetId=\(localId) via \(uti)")
                return localId
            }
        }
        return nil
    }
}

// MARK: - Models

struct SharePhotoItem {
    let data: Data
    let filename: String
    let mimeType: String
    let imageDataHash: String
    let fullHash: String
    let caption: String
    let isFavorite: Bool
    let capturedAtString: String
    let assetLocalIdentifier: String?
}

struct ShareAlbum: Identifiable {
    let id: Int
    let name: String
    let photoCount: Int
}

// MARK: - Hashing helpers (standalone, no FKPhotosLib dependency)

enum ShareHasher {
    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func fullHash(imageDataHash: String, caption: String, isFavorite: Bool, capturedAtString: String) -> String {
        let composite = imageDataHash + "\n" + caption + "\n" + (isFavorite ? "1" : "0") + "\n" + capturedAtString
        return sha256Hex(Data(composite.utf8))
    }

    static func mimeType(for uniformTypeIdentifier: String) -> String {
        let lower = uniformTypeIdentifier.lowercased()
        if lower.contains("heic") || lower.contains("heif") { return "image/heic" }
        if lower.contains("png")  { return "image/png" }
        if lower.contains("tiff") { return "image/tiff" }
        return "image/jpeg"
    }

    /// Returns the Photos.app caption via KVC, or nil if none is set.
    static func captionFromAsset(_ asset: PHAsset) -> String? {
        guard (asset as AnyObject).responds(to: NSSelectorFromString("descriptionProperties")),
              let descProps = (asset as NSObject).value(forKey: "descriptionProperties") as? NSObject,
              (descProps as AnyObject).responds(to: NSSelectorFromString("assetDescription")),
              let caption = descProps.value(forKey: "assetDescription") as? String,
              !caption.isEmpty else { return nil }
        return caption
    }

    /// ISO-8601 capture date with device timezone offset (TimeZone.current).
    static func capturedAtString(for asset: PHAsset, from data: Data) -> String {
        formatDate(asset.creationDate, timezone: TimeZone.current)
    }

    static func capturedAtStringFromData(capturedAt: Date?, imageData: Data) -> String {
        formatDate(capturedAt, timezone: TimeZone.current)
    }

    static func formatDate(_ date: Date?, timezone: TimeZone) -> String {
        guard let date else { return "" }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = timezone
        return f.string(from: date)
    }

    /// Returns true when the image bytes carry an XMP Rating >= 4 (Photos.app writes Rating=5 for favorites).
    /// Used as fallback when no PHAsset is available (e.g. share from non-Photos context or simulator).
    static func isFavoriteFromXMP(_ data: Data) -> Bool {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let metadata = CGImageSourceCopyMetadataAtIndex(source, 0, nil) else { return false }
        guard let tag = CGImageMetadataCopyTagWithPath(metadata, nil, "xmp:Rating" as CFString),
              let value = CGImageMetadataTagCopyValue(tag) else { return false }
        let rating: Int
        if let n = value as? NSNumber {
            rating = n.intValue
        } else if let s = value as? String, let n = Int(s) {
            rating = n
        } else {
            return false
        }
        print("[Share] XMP Rating=\(rating) → isFavorite=\(rating >= 4)")
        return rating >= 4
    }

    /// Extracts user-entered caption from image bytes.
    /// Only reads IPTC CaptionAbstract and XMP dc:description — both are explicitly user-authored fields.
    /// TIFFImageDescription and ExifUserComment are intentionally skipped: cameras auto-populate
    /// them with filenames (e.g. "DSC_0010") or technical data, not user captions.
    static func extractIPTCCaption(from data: Data) -> String? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        if let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
           let iptc = props[kCGImagePropertyIPTCDictionary] as? [CFString: Any],
           let s = iptc[kCGImagePropertyIPTCCaptionAbstract] as? String, !s.isEmpty {
            return s
        }
        if let metadata = CGImageSourceCopyMetadataAtIndex(source, 0, nil),
           let tag = CGImageMetadataCopyTagWithPath(metadata, nil, "dc:description" as CFString),
           let value = CGImageMetadataTagCopyValue(tag) {
            if let str = value as? String, !str.isEmpty { return str }
            if let arr = value as? [Any], let str = arr.first as? String, !str.isEmpty { return str }
        }
        return nil
    }
}

// MARK: - Lightweight queue writer (writes to the same file UploadQueue reads)

struct ShareQueueEntry: Codable {
    let id: UUID
    let tempFileURL: URL
}

enum ShareUploadQueueWriter {
    private static let appGroupID   = "group.dev.fk-encore.VivantyPhotos"
    private static let queueFile    = "upload_queue.json"
    private static let tempDirName  = "pending_uploads"

    private static var containerURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupID)
    }

    static var tempDirectory: URL {
        guard let c = containerURL else { return FileManager.default.temporaryDirectory }
        let dir = c.appendingPathComponent(tempDirName, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private static var queueFileURL: URL {
        containerURL?.appendingPathComponent(queueFile) ?? FileManager.default.temporaryDirectory.appendingPathComponent(queueFile)
    }

    // Minimal struct matching UploadQueueItem in FKPhotosLib (same JSON keys).
    private struct QueueItem: Codable {
        var id: UUID
        var assetLocalIdentifier: String?
        var tempFileURL: URL
        var filename: String
        var mimeType: String
        var imageDataHash: String
        var fullHash: String
        var caption: String
        var isFavorite: Bool
        var capturedAtString: String
        var targetAlbumIds: [Int]
        var status: String  // "pending" | "uploading" | "done" | "failed"
        var retryCount: Int
    }

    struct PendingItem {
        let id: UUID
        let tempFileURL: URL
        let filename: String
        let mimeType: String
        let imageDataHash: String
        let fullHash: String
        let caption: String
        let isFavorite: Bool
        let capturedAtString: String
        let targetAlbumIds: [Int]
    }

    static func pendingItems() -> [PendingItem] {
        loadAll()
            .filter { $0.status == "pending" || $0.status == "uploading" }
            .map { PendingItem(
                id: $0.id, tempFileURL: $0.tempFileURL, filename: $0.filename,
                mimeType: $0.mimeType, imageDataHash: $0.imageDataHash,
                fullHash: $0.fullHash, caption: $0.caption, isFavorite: $0.isFavorite,
                capturedAtString: $0.capturedAtString, targetAlbumIds: $0.targetAlbumIds
            )}
    }

    static func markFailed(id: UUID) {
        var all = loadAll()
        guard let idx = all.firstIndex(where: { $0.id == id }) else { return }
        all[idx].status = "failed"
        all[idx].retryCount += 1
        save(all)
    }

    static func enqueue(_ item: SharePhotoItem, albumIds: [Int]) -> ShareQueueEntry? {
        let itemId = UUID()
        let tempName = "\(itemId.uuidString)_\(item.filename)"
        let fileURL = tempDirectory.appendingPathComponent(tempName)
        guard (try? item.data.write(to: fileURL, options: .atomic)) != nil else { return nil }

        let entry = QueueItem(
            id: itemId,
            assetLocalIdentifier: item.assetLocalIdentifier,
            tempFileURL: fileURL,
            filename: item.filename,
            mimeType: item.mimeType,
            imageDataHash: item.imageDataHash,
            fullHash: item.fullHash,
            caption: item.caption,
            isFavorite: item.isFavorite,
            capturedAtString: item.capturedAtString,
            targetAlbumIds: albumIds,
            status: "pending",
            retryCount: 0
        )
        var all = loadAll()
        all.append(entry)
        save(all)
        return ShareQueueEntry(id: itemId, tempFileURL: fileURL)
    }

    static func markDone(id: UUID) {
        var all = loadAll()
        guard let idx = all.firstIndex(where: { $0.id == id }) else { return }
        let fileURL = all[idx].tempFileURL
        all[idx].status = "done"
        save(all)
        try? FileManager.default.removeItem(at: fileURL)
    }

    static func cancelAll() {
        let all = loadAll()
        for item in all where item.status == "pending" {
            try? FileManager.default.removeItem(at: item.tempFileURL)
        }
        let remaining = all.filter { $0.status != "pending" }
        save(remaining)
    }

    private static func loadAll() -> [QueueItem] {
        guard let data = try? Data(contentsOf: queueFileURL),
              let items = try? JSONDecoder().decode([QueueItem].self, from: data) else { return [] }
        return items
    }

    private static func save(_ items: [QueueItem]) {
        guard let data = try? JSONEncoder().encode(items) else { return }
        try? data.write(to: queueFileURL, options: .atomic)
    }
}

// MARK: - Shared configuration

enum ShareConfig {
    static let appGroupID        = "group.dev.fk-encore.VivantyPhotos"
    static let tokenKey          = "shared.auth_token"
    static let serverURLKey      = "shared.serverURL"
    static let recentAlbumIdsKey = "shared.recentAlbumIds"

    static var defaults: UserDefaults {
        UserDefaults(suiteName: appGroupID) ?? .standard
    }

    static var recentAlbumIds: [Int] {
        defaults.array(forKey: recentAlbumIdsKey) as? [Int] ?? []
    }

    static func saveRecentAlbumIds(_ ids: [Int]) {
        defaults.set(ids, forKey: recentAlbumIdsKey)
    }
}

// MARK: - Minimal API client (standalone, no FKPhotosLib dependency)

enum ShareAPIError: Error, LocalizedError {
    case notConfigured
    case notAuthenticated
    case httpError(Int)
    case duplicate(Int?)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Vivanty ist nicht eingerichtet. Bitte öffne die App und melde dich an."
        case .notAuthenticated:
            return "Nicht angemeldet – bitte öffne Vivanty und melde dich an."
        case .httpError(let code):
            return "HTTP-Fehler \(code)"
        case .duplicate:
            return "Foto bereits vorhanden"
        }
    }
}

enum ShareAPIClient {
    static func get(path: String) async throws -> Data {
        let request = try makeRequest(method: "GET", path: path)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShareAPIError.httpError(0) }
        guard (200...299).contains(http.statusCode) else {
            throw ShareAPIError.httpError(http.statusCode)
        }
        return data
    }

    /// Uploads a photo using all headers required by the hash-based sync protocol.
    static func uploadPhoto(item: SharePhotoItem) async throws -> Int {
        var request = try makeRequest(method: "POST", path: "/photos")
        request.timeoutInterval = 120
        request.setValue(item.mimeType, forHTTPHeaderField: "Content-Type")
        request.setValue(percentEncode(item.filename), forHTTPHeaderField: "X-File-Name")
        request.setValue(item.imageDataHash, forHTTPHeaderField: "X-Image-Data-Hash")
        request.setValue(item.fullHash, forHTTPHeaderField: "X-Full-Hash")
        request.setValue(percentEncode(item.caption), forHTTPHeaderField: "X-Description")
        request.setValue(item.isFavorite ? "true" : "false", forHTTPHeaderField: "X-Is-Favorite")
        request.setValue(item.capturedAtString, forHTTPHeaderField: "X-Captured-At")
        if let assetId = item.assetLocalIdentifier {
            request.setValue(assetId, forHTTPHeaderField: "X-Asset-Id")
        }
        request.httpBody = item.data
        print("""
        [Share Upload] \(item.filename)
          assetId:       \(item.assetLocalIdentifier ?? "nil")
          imageDataHash: \(item.imageDataHash)
          fullHash:      \(item.fullHash)
          caption:       "\(item.caption)"
          isFavorite:    \(item.isFavorite)
        """)

        let (responseData, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShareAPIError.httpError(0) }
        print("[Share Upload] \(item.filename) → HTTP \(http.statusCode)")
        if http.statusCode == 409 {
            struct Body: Decodable { let photoId: Int? }
            let existing = try? JSONDecoder().decode(Body.self, from: responseData)
            print("[Share Upload] \(item.filename) → duplicate (409), existingId=\(existing?.photoId as Any)")
            throw ShareAPIError.duplicate(existing?.photoId)
        }
        guard (200...299).contains(http.statusCode) else {
            throw ShareAPIError.httpError(http.statusCode)
        }
        struct Photo: Decodable { let id: Int? }
        // 200 = metadata update: body is {updated:true, photoId:Int}
        struct UpdateBody: Decodable { let photoId: Int? }
        if http.statusCode == 200 {
            let photoId = (try? JSONDecoder().decode(UpdateBody.self, from: responseData))?.photoId ?? 0
            print("[Share Upload] \(item.filename) → metadata-only update, photoId=\(photoId)")
            return photoId
        }
        let photoId = (try? JSONDecoder().decode(Photo.self, from: responseData))?.id ?? 0
        print("[Share Upload] \(item.filename) → NEW photo created, id=\(photoId)")
        return photoId
    }

    static func createAlbum(name: String) async throws -> ShareAlbum {
        var request = try makeRequest(method: "POST", path: "/albums")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        struct Body: Encodable { let name: String }
        struct Response: Decodable { let id: Int; let name: String; let photo_count: Int }
        request.httpBody = try JSONEncoder().encode(Body(name: name))
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200...299).contains(http.statusCode) else {
            throw ShareAPIError.httpError((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        let decoded = try JSONDecoder().decode(Response.self, from: data)
        return ShareAlbum(id: decoded.id, name: decoded.name, photoCount: decoded.photo_count)
    }

    static func addPhotoToAlbum(photoId: Int, albumId: Int) async throws {
        var request = try makeRequest(method: "POST", path: "/albums/photos")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        struct Body: Encodable { let albumId: Int; let photoId: Int }
        request.httpBody = try JSONEncoder().encode(Body(albumId: albumId, photoId: photoId))
        _ = try await URLSession.shared.data(for: request)
    }

    private static func percentEncode(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.formUnion(.init(charactersIn: "-_.~!*'()"))
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    private static func makeRequest(method: String, path: String) throws -> URLRequest {
        guard let serverURL = ShareConfig.defaults.string(forKey: ShareConfig.serverURLKey),
              let base = URL(string: serverURL) else {
            throw ShareAPIError.notConfigured
        }
        guard let token = ShareConfig.defaults.string(forKey: ShareConfig.tokenKey),
              !token.isEmpty else {
            throw ShareAPIError.notAuthenticated
        }
        var request = URLRequest(url: base.appendingPathComponent(path), timeoutInterval: 30)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }
}
