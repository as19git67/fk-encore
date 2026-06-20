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
    @State private var isLoadingAlbums = true
    @State private var isUploading = false
    @State private var uploadProgress = 0
    @State private var totalToUpload = 0
    @State private var errorMessage: String?
    @State private var isDone = false
    @State private var uploadTask: Task<Void, Never>? = nil

    var body: some View {
        NavigationStack {
            Group {
                if isLoadingAlbums {
                    ProgressView("Alben laden…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if isDone {
                    VStack(spacing: 16) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 56))
                            .foregroundStyle(.green)
                        Text(totalToUpload == 1
                             ? "1 Foto hochgeladen"
                             : "\(totalToUpload) Fotos hochgeladen")
                            .font(.headline)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    Form {
                        Section {
                            if albums.isEmpty {
                                Text("Keine Alben gefunden")
                                    .foregroundStyle(.secondary)
                            } else {
                                ForEach(albums) { album in
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
                }
            }
            .navigationTitle("In F4mil teilen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(isUploading ? "Abbrechen" : "Schließen") {
                        if isUploading {
                            uploadTask?.cancel()
                            uploadTask = nil
                            ShareUploadQueueWriter.cancelAll()
                            isUploading = false
                        }
                        extensionContext.cancelRequest(withError: CancellationError())
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isUploading {
                        HStack(spacing: 6) {
                            ProgressView().scaleEffect(0.8)
                            Text("\(uploadProgress)/\(totalToUpload)")
                                .font(.subheadline)
                                .monospacedDigit()
                        }
                    } else if !isDone {
                        Button("Hochladen") {
                            let task = Task { await performUpload() }
                            uploadTask = task
                        }
                    }
                }
            }
        }
        .task { await loadAlbums() }
        .onChange(of: isDone) { _, done in
            guard done else { return }
            Task {
                try? await Task.sleep(for: .seconds(1))
                extensionContext.completeRequest(returningItems: nil)
            }
        }
    }

    // MARK: - Album loading

    private func loadAlbums() async {
        do {
            let data = try await ShareAPIClient.get(path: "/albums")
            struct AlbumEntry: Decodable { let id: Int; let name: String; let photo_count: Int }
            struct Response: Decodable { let albums: [AlbumEntry] }
            let decoded = try JSONDecoder().decode(Response.self, from: data)
            albums = decoded.albums
                .map { ShareAlbum(id: $0.id, name: $0.name, photoCount: $0.photo_count) }
                .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        } catch {
            errorMessage = "Alben konnten nicht geladen werden. Bitte stelle sicher, dass du in F4mil angemeldet bist."
        }
        isLoadingAlbums = false
    }

    // MARK: - Upload

    private func performUpload() async {
        isUploading = true
        errorMessage = nil

        var items: [SharePhotoItem] = []
        for provider in itemProviders {
            if let item = await loadPhotoItem(from: provider) {
                items.append(item)
            }
        }

        guard !items.isEmpty else {
            errorMessage = "Kein unterstütztes Bild gefunden."
            isUploading = false
            return
        }

        totalToUpload = items.count
        ShareConfig.saveRecentAlbumIds(Array(selectedAlbumIds))
        let targetAlbumIds = Array(selectedAlbumIds)

        // Persist items to App Group queue so uploads survive extension close.
        var queueEntries: [ShareQueueEntry] = []
        for item in items {
            if let entry = ShareUploadQueueWriter.enqueue(item, albumIds: targetAlbumIds) {
                queueEntries.append(entry)
            }
        }

        var uploadedIds: [Int] = []
        for (index, item) in items.enumerated() {
            guard !Task.isCancelled else { break }
            do {
                let photoId = try await ShareAPIClient.uploadPhoto(item: item)
                uploadedIds.append(photoId)
                if index < queueEntries.count {
                    ShareUploadQueueWriter.markDone(id: queueEntries[index].id)
                }
            } catch ShareAPIError.duplicate(let existingId) {
                if let id = existingId {
                    uploadedIds.append(id)
                    if index < queueEntries.count {
                        ShareUploadQueueWriter.markDone(id: queueEntries[index].id)
                    }
                }
            } catch {
                errorMessage = error.localizedDescription
            }
            uploadProgress += 1
        }

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
        let assetId = await loadAssetIdentifier(from: provider)

        if let assetId,
           let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil).firstObject {
            if let item = await loadFromPhotoAsset(asset) { return item }
        }

        let isFavorite = assetId.flatMap {
            PHAsset.fetchAssets(withLocalIdentifiers: [$0], options: nil).firstObject
        }?.isFavorite ?? false
        let capturedAt = assetId.flatMap {
            PHAsset.fetchAssets(withLocalIdentifiers: [$0], options: nil).firstObject
        }?.creationDate
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
        let capturedAtString = ShareHasher.capturedAtString(for: asset, from: data)
        let fullHash = ShareHasher.fullHash(
            imageDataHash: imageDataHash,
            caption: caption,
            isFavorite: asset.isFavorite,
            capturedAtString: capturedAtString
        )
        return SharePhotoItem(
            data: data,
            filename: resource.originalFilename,
            mimeType: mimeType,
            imageDataHash: imageDataHash,
            fullHash: fullHash,
            caption: caption,
            isFavorite: asset.isFavorite,
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
                    let fullHash = ShareHasher.fullHash(
                        imageDataHash: imageDataHash,
                        caption: caption,
                        isFavorite: isFavorite,
                        capturedAtString: capturedAtString
                    )
                    cont.resume(returning: SharePhotoItem(
                        data: data, filename: filename, mimeType: mimeType,
                        imageDataHash: imageDataHash, fullHash: fullHash,
                        caption: caption, isFavorite: isFavorite,
                        capturedAtString: capturedAtString, assetLocalIdentifier: assetId
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
                        cont.resume(returning: url.host)
                    } else if let ids = item as? [String], let id = ids.first {
                        cont.resume(returning: id)
                    } else {
                        cont.resume(returning: nil)
                    }
                }
            }
            if let localId { return localId }
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

struct ShareQueueEntry: Codable {
    let id: UUID
    let tempFileURL: URL
}

// MARK: - Hashing helpers

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

    static func captionFromAsset(_ asset: PHAsset) -> String? {
        guard (asset as AnyObject).responds(to: NSSelectorFromString("descriptionProperties")),
              let descProps = (asset as NSObject).value(forKey: "descriptionProperties") as? NSObject,
              (descProps as AnyObject).responds(to: NSSelectorFromString("assetDescription")),
              let caption = descProps.value(forKey: "assetDescription") as? String,
              !caption.isEmpty else { return nil }
        return caption
    }

    static func capturedAtString(for asset: PHAsset, from data: Data) -> String {
        let tz = exifTimezone(from: data) ?? TimeZone.current
        return formatDate(asset.creationDate, timezone: tz)
    }

    static func capturedAtStringFromData(capturedAt: Date?, imageData: Data) -> String {
        let tz = exifTimezone(from: imageData) ?? TimeZone.current
        return formatDate(capturedAt, timezone: tz)
    }

    static func exifTimezone(from data: Data) -> TimeZone? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any] else { return nil }
        let offsetStr = (exif["OffsetTimeOriginal" as CFString] ?? exif["OffsetTime" as CFString]) as? String
        guard let off = offsetStr?.trimmingCharacters(in: .whitespaces), !off.isEmpty else { return nil }
        let sign = off.hasPrefix("-") ? -1 : 1
        let digits = off.filter { $0.isNumber }
        guard digits.count >= 3 else { return nil }
        let hours = Int(String(digits.prefix(2))) ?? 0
        let minutes = Int(String(digits.dropFirst(2).prefix(2))) ?? 0
        return TimeZone(secondsFromGMT: sign * (hours * 3600 + minutes * 60))
    }

    static func formatDate(_ date: Date?, timezone: TimeZone) -> String {
        guard let date else { return "" }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = timezone
        return f.string(from: date)
    }

    static func extractIPTCCaption(from data: Data) -> String? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        if let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] {
            if let iptc = props[kCGImagePropertyIPTCDictionary] as? [CFString: Any] {
                if let s = iptc[kCGImagePropertyIPTCCaptionAbstract] as? String, !s.isEmpty { return s }
                if let s = iptc[kCGImagePropertyIPTCHeadline] as? String, !s.isEmpty { return s }
            }
            if let tiff = props[kCGImagePropertyTIFFDictionary] as? [CFString: Any],
               let s = tiff[kCGImagePropertyTIFFImageDescription] as? String, !s.isEmpty { return s }
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

// MARK: - Lightweight queue writer

enum ShareUploadQueueWriter {
    private static let appGroupID  = "group.dev.fk-encore.F4milPhotos"
    private static let queueFile   = "upload_queue.json"
    private static let tempDirName = "pending_uploads"

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
        containerURL?.appendingPathComponent(queueFile)
            ?? FileManager.default.temporaryDirectory.appendingPathComponent(queueFile)
    }

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
        var status: String
        var retryCount: Int
    }

    static func enqueue(_ item: SharePhotoItem, albumIds: [Int]) -> ShareQueueEntry? {
        let itemId = UUID()
        let dest = tempDirectory.appendingPathComponent("\(itemId.uuidString)_\(item.filename)")
        guard (try? item.data.write(to: dest, options: .atomic)) != nil else { return nil }
        var all = loadAll()
        all.append(QueueItem(
            id: itemId, assetLocalIdentifier: item.assetLocalIdentifier,
            tempFileURL: dest, filename: item.filename, mimeType: item.mimeType,
            imageDataHash: item.imageDataHash, fullHash: item.fullHash,
            caption: item.caption, isFavorite: item.isFavorite,
            capturedAtString: item.capturedAtString, targetAlbumIds: albumIds,
            status: "pending", retryCount: 0
        ))
        save(all)
        return ShareQueueEntry(id: itemId, tempFileURL: dest)
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
        save(all.filter { $0.status != "pending" })
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
    static let appGroupID        = "group.dev.fk-encore.F4milPhotos"
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

// MARK: - Minimal API client

enum ShareAPIError: Error, LocalizedError {
    case notConfigured
    case notAuthenticated
    case httpError(Int)
    case duplicate(Int?)

    var errorDescription: String? {
        switch self {
        case .notConfigured:   return "F4mil ist nicht eingerichtet. Bitte öffne die App und melde dich an."
        case .notAuthenticated: return "Nicht angemeldet – bitte öffne F4mil und melde dich an."
        case .httpError(let c): return "HTTP-Fehler \(c)"
        case .duplicate:       return "Foto bereits vorhanden"
        }
    }
}

enum ShareAPIClient {
    static func get(path: String) async throws -> Data {
        let request = try makeRequest(method: "GET", path: path)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShareAPIError.httpError(0) }
        guard (200...299).contains(http.statusCode) else { throw ShareAPIError.httpError(http.statusCode) }
        return data
    }

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
        request.httpBody = item.data

        let (responseData, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShareAPIError.httpError(0) }
        if http.statusCode == 409 {
            struct Body: Decodable { let photoId: Int? }
            throw ShareAPIError.duplicate((try? JSONDecoder().decode(Body.self, from: responseData))?.photoId)
        }
        guard (200...299).contains(http.statusCode) else { throw ShareAPIError.httpError(http.statusCode) }
        if http.statusCode == 200 {
            struct UpdateBody: Decodable { let photoId: Int? }
            return (try? JSONDecoder().decode(UpdateBody.self, from: responseData))?.photoId ?? 0
        }
        struct Photo: Decodable { let id: Int }
        return try JSONDecoder().decode(Photo.self, from: responseData).id
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
              let base = URL(string: serverURL) else { throw ShareAPIError.notConfigured }
        guard let token = ShareConfig.defaults.string(forKey: ShareConfig.tokenKey),
              !token.isEmpty else { throw ShareAPIError.notAuthenticated }
        var request = URLRequest(url: base.appendingPathComponent(path), timeoutInterval: 30)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }
}
