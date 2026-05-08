import UIKit
import SwiftUI
import UniformTypeIdentifiers
import Photos
import ImageIO

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
    @State private var isDone = false

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
                }
            }
            .navigationTitle("In Vivanty teilen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") {
                        extensionContext.cancelRequest(withError: CancellationError())
                    }
                    .disabled(isUploading)
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        newAlbumName = ""
                        showNewAlbum = true
                    } label: {
                        Image(systemName: "folder.badge.plus")
                    }
                    .disabled(isUploading || isLoadingAlbums)
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
                            Task { await performUpload() }
                        }
                    }
                }
            }
        }
        .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always), prompt: "Album suchen")
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

        var items: [(Data, String, String, Bool, Date?, String?)] = []
        for provider in itemProviders {
            if let item = await loadImageData(from: provider) {
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

        var uploadedIds: [Int] = []
        for (data, filename, mimeType, isFavorite, capturedAt, caption) in items {
            var resolvedId: Int? = nil
            do {
                let photoId = try await ShareAPIClient.uploadPhoto(
                    data: data, filename: filename, mimeType: mimeType,
                    isFavorite: isFavorite, capturedAt: capturedAt)
                uploadedIds.append(photoId)
                resolvedId = photoId
            } catch ShareAPIError.duplicate(let existingId) {
                if let id = existingId {
                    uploadedIds.append(id)
                    resolvedId = id
                }
            } catch {
                errorMessage = error.localizedDescription
            }
            // When sharing from Photos.app the exported bytes include the
            // Photos.app caption as IPTC. For new uploads the server already
            // extracts it; for duplicates (photo already uploaded via background
            // sync but without caption) we PATCH explicitly to close the gap.
            if let id = resolvedId, let caption {
                try? await ShareAPIClient.patchDescription(photoId: id, description: caption)
            }
            uploadProgress += 1
        }

        for albumId in selectedAlbumIds {
            for photoId in uploadedIds {
                try? await ShareAPIClient.addPhotoToAlbum(photoId: photoId, albumId: albumId)
            }
        }

        if errorMessage == nil { isDone = true }
        isUploading = false
    }

    // MARK: - Image data loading

    private func loadImageData(from provider: NSItemProvider) async -> (Data, String, String, Bool, Date?, String?)? {
        let meta = await loadAssetMetadata(from: provider)
        let candidates: [(String, String, String)] = [
            (UTType.heic.identifier,  "heic", "image/heic"),
            (UTType.jpeg.identifier,  "jpg",  "image/jpeg"),
            (UTType.png.identifier,   "png",  "image/png"),
            (UTType.tiff.identifier,  "tiff", "image/tiff"),
            ("public.image",          "jpg",  "image/jpeg"),
        ]
        for (uti, ext, mime) in candidates {
            guard provider.hasItemConformingToTypeIdentifier(uti) else { continue }
            let result: (Data, String, String, Bool, Date?, String?)? = await withCheckedContinuation { cont in
                provider.loadDataRepresentation(forTypeIdentifier: uti) { data, _ in
                    guard let data else { cont.resume(returning: nil); return }
                    // Photos.app embeds the caption as IPTC when exporting via the
                    // Share Sheet — extract it here so it can be synced to the server.
                    let caption = Self.extractIPTCCaption(from: data)
                    cont.resume(returning: (data, "photo.\(ext)", mime, meta.isFavorite, meta.capturedAt, caption))
                }
            }
            if let result { return result }
        }
        return nil
    }

    /// Extracts the user-entered caption / description from image bytes by checking
    /// IPTC Caption-Abstract, TIFF ImageDescription, and EXIF UserComment in order.
    /// When Photos.app exports a photo via Share Sheet it embeds the caption as IPTC,
    /// which is why this works here but not via PHContentEditingInput.
    private static func extractIPTCCaption(from data: Data) -> String? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        else { return nil }
        if let iptc = props[kCGImagePropertyIPTCDictionary] as? [CFString: Any],
           let s = iptc[kCGImagePropertyIPTCCaptionAbstract] as? String, !s.isEmpty { return s }
        if let tiff = props[kCGImagePropertyTIFFDictionary] as? [CFString: Any],
           let s = tiff[kCGImagePropertyTIFFImageDescription] as? String, !s.isEmpty { return s }
        if let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any],
           let s = exif[kCGImagePropertyExifUserComment] as? String, !s.isEmpty { return s }
        return nil
    }

    /// Best-effort: reads PHAsset metadata (isFavorite, creationDate) when the
    /// provider exposes an asset identifier (happens when sharing from Photos.app).
    private func loadAssetMetadata(from provider: NSItemProvider) async -> (isFavorite: Bool, capturedAt: Date?) {
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
            if let id = localId,
               let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject {
                return (isFavorite: asset.isFavorite, capturedAt: asset.creationDate)
            }
        }
        return (isFavorite: false, capturedAt: nil)
    }
}

// MARK: - Models

struct ShareAlbum: Identifiable {
    let id: Int
    let name: String
    let photoCount: Int
}

// MARK: - Shared configuration (mirrors SharedStorage from the main app)

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

    private static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func uploadPhoto(data: Data, filename: String, mimeType: String,
                            isFavorite: Bool = false, capturedAt: Date? = nil) async throws -> Int {
        var request = try makeRequest(method: "POST", path: "/photos")
        request.setValue(mimeType, forHTTPHeaderField: "Content-Type")
        request.setValue(filename, forHTTPHeaderField: "X-File-Name")
        if isFavorite { request.setValue("true", forHTTPHeaderField: "X-Is-Favorite") }
        if let date = capturedAt { request.setValue(iso8601.string(from: date), forHTTPHeaderField: "X-Captured-At") }
        request.httpBody = data
        request.timeoutInterval = 120

        let (responseData, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShareAPIError.httpError(0) }
        if http.statusCode == 409 {
            struct Body: Decodable { let photoId: Int? }
            let existing = try? JSONDecoder().decode(Body.self, from: responseData)
            throw ShareAPIError.duplicate(existing?.photoId)
        }
        guard (200...299).contains(http.statusCode) else {
            throw ShareAPIError.httpError(http.statusCode)
        }
        struct Photo: Decodable { let id: Int }
        return try JSONDecoder().decode(Photo.self, from: responseData).id
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

    static func patchDescription(photoId: Int, description: String) async throws {
        var request = try makeRequest(method: "PATCH", path: "/photos/\(photoId)/description")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        struct Body: Encodable { let description: String }
        request.httpBody = try JSONEncoder().encode(Body(description: description))
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200...299).contains(http.statusCode) else {
            throw ShareAPIError.httpError((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
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
