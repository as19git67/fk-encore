import UIKit
import SwiftUI
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
            .navigationTitle("In Vivanty teilen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") {
                        extensionContext.cancelRequest(withError: CancellationError())
                    }
                    .disabled(isUploading)
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
            errorMessage = "Alben konnten nicht geladen werden. Bitte stelle sicher, dass du in Vivanty angemeldet bist."
        }
        isLoadingAlbums = false
    }

    // MARK: - Upload

    private func performUpload() async {
        isUploading = true
        errorMessage = nil

        var items: [(Data, String, String)] = []
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
        for (data, filename, mimeType) in items {
            do {
                let photoId = try await ShareAPIClient.uploadPhoto(
                    data: data, filename: filename, mimeType: mimeType)
                uploadedIds.append(photoId)
            } catch ShareAPIError.duplicate(let existingId) {
                if let id = existingId { uploadedIds.append(id) }
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

        if errorMessage == nil { isDone = true }
        isUploading = false
    }

    // MARK: - Image data loading

    private func loadImageData(from provider: NSItemProvider) async -> (Data, String, String)? {
        let candidates: [(String, String, String)] = [
            (UTType.heic.identifier,  "heic", "image/heic"),
            (UTType.jpeg.identifier,  "jpg",  "image/jpeg"),
            (UTType.png.identifier,   "png",  "image/png"),
            (UTType.tiff.identifier,  "tiff", "image/tiff"),
            ("public.image",          "jpg",  "image/jpeg"),  // generic fallback
        ]
        for (uti, ext, mime) in candidates {
            guard provider.hasItemConformingToTypeIdentifier(uti) else { continue }
            let result: (Data, String, String)? = await withCheckedContinuation { cont in
                provider.loadDataRepresentation(forTypeIdentifier: uti) { data, _ in
                    guard let data else { cont.resume(returning: nil); return }
                    cont.resume(returning: (data, "photo.\(ext)", mime))
                }
            }
            if let result { return result }
        }
        return nil
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

    static func uploadPhoto(data: Data, filename: String, mimeType: String) async throws -> Int {
        var request = try makeRequest(method: "POST", path: "/photos")
        request.setValue(mimeType, forHTTPHeaderField: "Content-Type")
        request.setValue(filename, forHTTPHeaderField: "X-File-Name")
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

    static func addPhotoToAlbum(photoId: Int, albumId: Int) async throws {
        var request = try makeRequest(method: "POST", path: "/albums/photos")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        struct Body: Encodable { let albumId: Int; let photoId: Int }
        request.httpBody = try JSONEncoder().encode(Body(albumId: albumId, photoId: photoId))
        _ = try await URLSession.shared.data(for: request)
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
