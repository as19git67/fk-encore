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
        // Photos keep the flow they have always had; a link or a piece
        // of text is a find for the trip planner (§9.2).
        let host: UIHostingController<AnyView>
        switch ShareKind.of(providers) {
        case .photos:
            host = UIHostingController(rootView: AnyView(ShareUploadView(
                extensionContext: extensionContext!,
                itemProviders: providers
            )))
        case .tripFind:
            host = UIHostingController(rootView: AnyView(TripShareCaptureView(
                extensionContext: extensionContext!,
                itemProviders: providers
            )))
        }
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
            .navigationTitle("In F4mil teilen")
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
                if !isUploading && !isDone {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            newAlbumName = ""
                            showNewAlbum = true
                        } label: {
                            Image(systemName: "folder.badge.plus")
                        }
                        .disabled(isLoadingAlbums)
                    }
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

    /// When the share originates from the Photos app, requests Photos-library
    /// read access so each item can be resolved to its `PHAsset`. The favourite
    /// flag is the reason: Photos keeps it in its database, never in the shared
    /// file, so `asset.isFavorite` is the only way to read it — without access
    /// `PHAsset.fetchAssets` returns nothing inside an extension and the
    /// favourite is lost.
    ///
    /// The prompt is skipped entirely when no item carries a Photos asset
    /// identifier (i.e. the share came from another app) — those uploads need
    /// no PHAsset and go through the raw item-provider path. A denied prompt is
    /// harmless too: the loader falls back to the item-provider bytes.
    private func ensurePhotoLibraryAccess() async {
        let sharedFromPhotosApp = itemProviders.contains { provider in
            provider.hasItemConformingToTypeIdentifier("com.apple.photos.asset")
                || provider.hasItemConformingToTypeIdentifier("com.apple.photos.asset-identifiers")
        }
        guard sharedFromPhotosApp else { return }

        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .notDetermined {
            _ = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        }
    }

    private func performUpload() async {
        isUploading = true
        errorMessage = nil

        // Resolve Photos access before any item is loaded so the PHAsset path
        // (authoritative favourite flag) is available when the share came from
        // the Photos app. Shares from other apps skip the prompt entirely.
        await ensurePhotoLibraryAccess()

        let prevItems = previousPendingItems
        totalToUpload = prevItems.count + itemProviders.count
        uploadProgress = 0

        guard totalToUpload > 0 else {
            errorMessage = "Kein unterstütztes Bild gefunden."
            isUploading = false
            return
        }

        ShareConfig.saveRecentAlbumIds(Array(selectedAlbumIds))
        let targetAlbumIds = Array(selectedAlbumIds)

        var uploadedIds: [Int] = []
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
                capturedAtString: prev.capturedAtString, assetLocalIdentifier: nil,
                latitude: prev.latitude, longitude: prev.longitude
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
                prevItemErrorMessage = error.localizedDescription
                ShareUploadQueueWriter.markFailed(id: prev.id)
            }
            uploadProgress += 1
        }

        // 2. Process new items one at a time — load, enqueue to disk, upload, release.
        //    Only one photo's bytes are in RAM at a time (Share Extensions have ~120 MB).
        var newItemCount = 0
        for provider in itemProviders {
            guard !Task.isCancelled else { break }

            guard let item = await loadPhotoItem(from: provider) else {
                uploadProgress += 1
                continue
            }
            newItemCount += 1

            if uploadedPrevHashes.contains(item.imageDataHash) {
                print("[Share Upload] skipping duplicate \(item.filename) (already uploaded via prevItems)")
                uploadProgress += 1
                continue
            }

            // Metadata-only fast path: pixels unchanged since last sync.
            var metadataSynced = false
            if let localId = item.assetLocalIdentifier, !localId.isEmpty {
                let syncedEntry = ShareSyncedState.loadEntry(localId: localId)
                if let syncedEntry, syncedEntry.imageDataHash == item.imageDataHash {
                    if let photoId = try? await ShareAPIClient.syncPhotoMetadata(item: item) {
                        uploadedIds.append(photoId)
                        ShareSyncedState.saveEntry(localId: localId, imageDataHash: item.imageDataHash, fullHash: item.fullHash)
                        metadataSynced = true
                    }
                }
            }

            if !metadataSynced {
                // Enqueue to persistent queue first so the main app can retry if the
                // extension is killed before the upload finishes.
                let entry = ShareUploadQueueWriter.enqueue(item, albumIds: targetAlbumIds)

                do {
                    let photoId = try await ShareAPIClient.uploadPhoto(item: item)
                    uploadedIds.append(photoId)
                    if let localId = item.assetLocalIdentifier, !localId.isEmpty {
                        ShareSyncedState.saveEntry(localId: localId, imageDataHash: item.imageDataHash, fullHash: item.fullHash)
                    }
                    if let entry { ShareUploadQueueWriter.markDone(id: entry.id) }
                } catch ShareAPIError.duplicate(let existingId) {
                    if let id = existingId { uploadedIds.append(id) }
                    if let localId = item.assetLocalIdentifier, !localId.isEmpty {
                        ShareSyncedState.saveEntry(localId: localId, imageDataHash: item.imageDataHash, fullHash: item.fullHash)
                    }
                    if let entry { ShareUploadQueueWriter.markDone(id: entry.id) }
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
            // item goes out of scope here → image data freed from RAM
            uploadProgress += 1
        }

        if newItemCount == 0 && prevItems.isEmpty {
            errorMessage = "Kein unterstütztes Bild gefunden."
            isUploading = false
            return
        }

        // 3. Add all uploaded photos to currently selected albums.
        for albumId in selectedAlbumIds {
            for photoId in uploadedIds {
                try? await ShareAPIClient.addPhotoToAlbum(photoId: photoId, albumId: albumId)
            }
        }

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
        let asset = assetId.flatMap { PHAsset.fetchAssets(withLocalIdentifiers: [$0], options: nil).firstObject }
        let isFavorite = asset?.isFavorite ?? false
        let capturedAt = asset?.creationDate
        return await loadFromItemProvider(
            provider,
            isFavorite: isFavorite,
            capturedAt: capturedAt,
            latitude: asset?.location?.coordinate.latitude,
            longitude: asset?.location?.coordinate.longitude,
            assetId: assetId
        )
    }

    private func loadFromPhotoAsset(_ asset: PHAsset) async -> SharePhotoItem? {
        // Prefer the edited render so crops/adjustments are shared at full
        // quality, matching the main app's hash/upload selection (issue #591).
        guard let resource = PHAssetResource.assetResources(for: asset)
            .first(where: { $0.type == .fullSizePhoto })
            ?? PHAssetResource.assetResources(for: asset).first(where: { $0.type == .photo })
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

        let imageDataHash = ShareHasher.imageDataHash(data)
        // The Photos-app caption / favourite flag take precedence, but fall
        // back to the file's own IPTC/XMP metadata so an embedded caption or
        // xmp:Rating still reaches the server when the Photos database carries
        // none — loadFromItemProvider already mines the same fields.
        let caption = ShareHasher.captionFromAsset(asset)
            ?? ShareHasher.extractIPTCCaption(from: data)
            ?? ""
        let isFavorite = asset.isFavorite || ShareHasher.isFavoriteFromXMP(data)
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
            assetLocalIdentifier: asset.localIdentifier,
            latitude: asset.location?.coordinate.latitude,
            longitude: asset.location?.coordinate.longitude
        )
    }

    private func loadFromItemProvider(
        _ provider: NSItemProvider,
        isFavorite: Bool,
        capturedAt: Date?,
        latitude: Double?,
        longitude: Double?,
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
                    let imageDataHash = ShareHasher.imageDataHash(data)
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
                        assetLocalIdentifier: assetId,
                        latitude: latitude,
                        longitude: longitude
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
    /// PHAsset.location coordinates, read from PhotoKit's own database.
    /// Forwarded to the server via X-GPS-* headers so a missing-EXIF-GPS
    /// situation (observed for HEIC originals fetched via PHAssetResource)
    /// doesn't drop the location.
    let latitude: Double?
    let longitude: Double?
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

    /// SHA-256 of the image's *decoded pixel data*, independent of any
    /// EXIF/IPTC/XMP metadata in the file container.
    ///
    /// The Photos app re-exports a shared photo with its current caption
    /// embedded, so hashing the file bytes is unstable across caption edits.
    /// Re-wrapping the file with CGImageDestination does NOT help: it *merges*
    /// the source metadata rather than dropping it (and may fail outright for
    /// HEIC), so the caption survives. Decoding the image to pixels and hashing
    /// those is metadata-proof — only an actual pixel change moves the hash.
    ///
    /// The image is decoded at a bounded size so a large photo cannot exhaust
    /// the Share Extension's tight (~120 MB) memory budget. Falls back to
    /// hashing the raw bytes only when the image cannot be decoded at all.
    static func imageDataHash(_ data: Data) -> String {
        sha256Hex(decodedPixelData(data) ?? data)
    }

    /// Decodes the image to a bounded-size bitmap and returns its raw pixel
    /// bytes in a fixed RGBA layout — deterministic for identical pixels and
    /// free of any container metadata. Returns nil when the data cannot be
    /// decoded.
    private static func decodedPixelData(_ data: Data) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: 1024,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return nil
        }
        let width = image.width
        let height = image.height
        guard width > 0, height > 0 else { return nil }
        let bytesPerRow = width * 4
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let pixels = context.data else { return nil }
        return Data(bytes: pixels, count: height * bytesPerRow)
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

    /// Returns true when the image bytes carry an XMP Rating >= 4.
    /// Used as a fallback for the favourite flag whenever the Photos database
    /// has none — both when no PHAsset is available (share from a non-Photos
    /// context or the simulator) and when asset.isFavorite is false but the
    /// file itself carries a rating (e.g. rated in Lightroom, or a photo
    /// previously downloaded from the server, which writes xmp:Rating).
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
    private static let appGroupID   = "group.dev.fk-encore.F4milPhotos"
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
        var tempFileURL: URL?
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
        /// PHAsset.location coordinates persisted so a later session (without
        /// a usable PHAsset) can still forward GPS via X-GPS-* headers.
        var latitude: Double?
        var longitude: Double?
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
        let latitude: Double?
        let longitude: Double?
    }

    static func pendingItems() -> [PendingItem] {
        // Exclude "uploading" so we don't pick up an item the main app is
        // currently in the middle of uploading — that race was one of the
        // sources of duplicate server-side photos.
        loadAll()
            .filter { $0.status == "pending" }
            .compactMap { item in
                guard let url = item.tempFileURL else { return nil }
                return PendingItem(
                    id: item.id, tempFileURL: url, filename: item.filename,
                    mimeType: item.mimeType, imageDataHash: item.imageDataHash,
                    fullHash: item.fullHash, caption: item.caption, isFavorite: item.isFavorite,
                    capturedAtString: item.capturedAtString, targetAlbumIds: item.targetAlbumIds,
                    latitude: item.latitude, longitude: item.longitude
                )
            }
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
            retryCount: 0,
            latitude: item.latitude,
            longitude: item.longitude
        )
        var all = loadAll()
        all.append(entry)
        save(all)
        return ShareQueueEntry(id: itemId, tempFileURL: fileURL)
    }

    static func markDone(id: UUID) {
        var all = loadAll()
        guard let idx = all.firstIndex(where: { $0.id == id }) else { return }
        if let fileURL = all[idx].tempFileURL {
            try? FileManager.default.removeItem(at: fileURL)
        }
        all[idx].status = "done"
        save(all)
    }

    static func cancelAll() {
        let all = loadAll()
        for item in all where item.status == "pending" {
            if let url = item.tempFileURL { try? FileManager.default.removeItem(at: url) }
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

// MARK: - Synced state (shared with main app via App Group)

enum ShareSyncedState {
    private static let syncedStateKey = "sync.syncedState"

    struct Entry: Codable {
        let imageDataHash: String
        let fullHash: String
    }

    static func loadEntry(localId: String) -> Entry? {
        guard let data = ShareConfig.defaults.data(forKey: syncedStateKey),
              let cache = try? JSONDecoder().decode([String: Entry].self, from: data) else { return nil }
        return cache[localId]
    }

    static func saveEntry(localId: String, imageDataHash: String, fullHash: String) {
        var cache: [String: Entry] = [:]
        if let data = ShareConfig.defaults.data(forKey: syncedStateKey),
           let existing = try? JSONDecoder().decode([String: Entry].self, from: data) {
            cache = existing
        }
        cache[localId] = Entry(imageDataHash: imageDataHash, fullHash: fullHash)
        if let data = try? JSONEncoder().encode(cache) {
            ShareConfig.defaults.set(data, forKey: syncedStateKey)
        }
    }
}

// MARK: - Shared configuration

enum ShareConfig {
    static let appGroupID        = "group.dev.fk-encore.F4milPhotos"
    static let tokenKey          = "shared.auth_token"
    static let refreshTokenKey   = "shared.refresh_token"
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
            return "F4mil ist nicht eingerichtet. Bitte öffne die App und melde dich an."
        case .notAuthenticated:
            return "Nicht angemeldet – bitte öffne F4mil und melde dich an."
        case .httpError(let code):
            return "HTTP-Fehler \(code)"
        case .duplicate:
            return "Foto bereits vorhanden"
        }
    }
}

enum ShareAPIClient {
    static func get(path: String) async throws -> Data {
        let (data, http) = try await performWithRefresh {
            try makeRequest(method: "GET", path: path)
        }
        guard (200...299).contains(http.statusCode) else {
            throw ShareAPIError.httpError(http.statusCode)
        }
        return data
    }

    /// Uploads a photo using all headers required by the hash-based sync protocol.
    static func uploadPhoto(item: SharePhotoItem) async throws -> Int {
        print("""
        [Share Upload] \(item.filename)
          assetId:       \(item.assetLocalIdentifier ?? "nil")
          imageDataHash: \(item.imageDataHash)
          fullHash:      \(item.fullHash)
          caption:       "\(item.caption)"
          isFavorite:    \(item.isFavorite)
          gps:           \(item.latitude.map { String($0) } ?? "nil"),\(item.longitude.map { String($0) } ?? "nil")
        """)

        let (responseData, http) = try await performWithRefresh {
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
            // GPS fallback — see SharePhotoItem.latitude/longitude.
            if let lat = item.latitude, lat.isFinite {
                request.setValue(String(lat), forHTTPHeaderField: "X-GPS-Lat")
            }
            if let lng = item.longitude, lng.isFinite {
                request.setValue(String(lng), forHTTPHeaderField: "X-GPS-Lng")
            }
            request.httpBody = item.data
            return request
        }
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
        struct Body: Encodable { let name: String }
        struct Response: Decodable { let id: Int; let name: String; let photo_count: Int }
        let (data, http) = try await performWithRefresh {
            var request = try makeRequest(method: "POST", path: "/albums")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(Body(name: name))
            return request
        }
        guard (200...299).contains(http.statusCode) else {
            throw ShareAPIError.httpError(http.statusCode)
        }
        let decoded = try JSONDecoder().decode(Response.self, from: data)
        return ShareAlbum(id: decoded.id, name: decoded.name, photoCount: decoded.photo_count)
    }

    /// Metadata-only sync: sends JSON to POST /photos/sync/metadata (no image body).
    /// Returns the photo id on success, or nil if the server doesn't recognise the photo.
    static func syncPhotoMetadata(item: SharePhotoItem) async throws -> Int? {
        struct Body: Encodable {
            let imageDataHash: String
            let deviceAssetId: String
            let fullHash: String
            let description: String
            let isFavorite: Bool
            let capturedAt: String
        }
        print("[Share MetadataSync] \(item.filename) imageDataHash=\(item.imageDataHash)")
        let (responseData, http) = try await performWithRefresh {
            var request = try makeRequest(method: "POST", path: "/photos/sync/metadata")
            request.timeoutInterval = 30
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(Body(
                imageDataHash: item.imageDataHash,
                deviceAssetId: item.assetLocalIdentifier ?? "",
                fullHash: item.fullHash,
                description: item.caption,
                isFavorite: item.isFavorite,
                capturedAt: item.capturedAtString
            ))
            return request
        }
        if http.statusCode == 404 {
            print("[Share MetadataSync] \(item.filename) → not found, falling back to full upload")
            return nil
        }
        guard (200...299).contains(http.statusCode) else {
            throw ShareAPIError.httpError(http.statusCode)
        }
        struct Response: Decodable { let photoId: Int }
        let photoId = (try? JSONDecoder().decode(Response.self, from: responseData))?.photoId ?? 0
        print("[Share MetadataSync] \(item.filename) → updated, photoId=\(photoId)")
        return photoId
    }

    static func addPhotoToAlbum(photoId: Int, albumId: Int) async throws {
        struct Body: Encodable { let albumId: Int; let photoId: Int }
        _ = try await performWithRefresh {
            var request = try makeRequest(method: "POST", path: "/albums/photos")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(Body(albumId: albumId, photoId: photoId))
            return request
        }
    }

    /// Performs the built request; on HTTP 401 it refreshes the shared access
    /// token once and retries. The request is rebuilt for the retry so it picks
    /// up the fresh token (and re-sends the body).
    private static func performWithRefresh(
        _ build: () throws -> URLRequest
    ) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await URLSession.shared.data(for: build())
        guard let http = response as? HTTPURLResponse else { throw ShareAPIError.httpError(0) }
        if http.statusCode != 401 { return (data, http) }
        guard await refreshSharedToken() else { return (data, http) }
        let (retryData, retryResponse) = try await URLSession.shared.data(for: build())
        guard let retryHttp = retryResponse as? HTTPURLResponse else { throw ShareAPIError.httpError(0) }
        return (retryData, retryHttp)
    }

    /// Refreshes the shared access token using the refresh token from the App
    /// Group, writing the rotated tokens back so the next request — and the
    /// main app — pick them up. Returns false when there is no refresh token or
    /// the refresh failed; the user must then reopen the app and sign in.
    private static func refreshSharedToken() async -> Bool {
        guard let serverURL = ShareConfig.defaults.string(forKey: ShareConfig.serverURLKey),
              let base = URL(string: serverURL),
              let refreshToken = ShareConfig.defaults.string(forKey: ShareConfig.refreshTokenKey),
              !refreshToken.isEmpty
        else { return false }

        var request = URLRequest(url: base.appendingPathComponent("/auth/refresh"), timeoutInterval: 30)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        struct Body: Encodable { let refreshToken: String }
        struct TokenResponse: Decodable { let token: String; let refreshToken: String }
        guard let httpBody = try? JSONEncoder().encode(Body(refreshToken: refreshToken)) else { return false }
        request.httpBody = httpBody

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse,
              (200...299).contains(http.statusCode),
              let decoded = try? JSONDecoder().decode(TokenResponse.self, from: data)
        else {
            print("[Share Auth] token refresh failed — extension needs a fresh login via the app")
            return false
        }
        ShareConfig.defaults.set(decoded.token, forKey: ShareConfig.tokenKey)
        ShareConfig.defaults.set(decoded.refreshToken, forKey: ShareConfig.refreshTokenKey)
        print("[Share Auth] access token refreshed")
        return true
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
