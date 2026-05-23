import SwiftUI

// MARK: - Drag-to-select support

struct PhotoFramePreference: PreferenceKey {
    static var defaultValue: [Int: CGRect] = [:]
    static func reduce(value: inout [Int: CGRect], nextValue: () -> [Int: CGRect]) {
        value.merge(nextValue()) { $1 }
    }
}

extension View {
    func reportPhotoFrame(id: Int, space: String) -> some View {
        background(GeometryReader { geo in
            Color.clear.preference(key: PhotoFramePreference.self,
                                   value: [id: geo.frame(in: .named(space))])
        })
    }
}

// MARK: - Selection checkmark overlay

struct SelectionCheckmark: View {
    let isSelected: Bool

    var body: some View {
        ZStack {
            Circle()
                .fill(isSelected ? Color.accentColor : Color.black.opacity(0.3))
                .frame(width: 24, height: 24)
            if isSelected {
                Image(systemName: "checkmark")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.white)
            } else {
                Circle()
                    .strokeBorder(.white, lineWidth: 1.5)
                    .frame(width: 24, height: 24)
            }
        }
    }
}

// MARK: - Photo share manager

@Observable @MainActor
final class PhotoShareManager {
    var isLoading = false
    var images: [UIImage] = []
    var isPresented = false

    func share(filenames: [String]) async {
        isLoading = true
        images = []
        for filename in filenames {
            if let cached = await ImageCache.shared.image(forKey: "photo-\(filename)") {
                images.append(cached)
            } else if let data = try? await APIClient.shared.downloadData("/photos/file/\(filename)"),
                      let image = UIImage(data: data) {
                images.append(image)
            }
        }
        isLoading = false
        if !images.isEmpty {
            isPresented = true
        }
    }
}

// MARK: - iOS share sheet wrapper

struct ActivityView: UIViewControllerRepresentable {
    let images: [UIImage]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: images, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

// MARK: - Add selected photos to server album

@Observable @MainActor
final class AddToAlbumManager {
    var isPresented = false
    var isAdding = false
    var resultMessage: String?
    private(set) var photoIds: [Int] = []

    func present(photoIds: Set<Int>) {
        self.photoIds = Array(photoIds)
        isPresented = true
    }

    func addToAlbum(_ albumId: Int) async {
        isAdding = true
        defer { isAdding = false }
        do {
            let _: BoolResponse = try await APIClient.shared.post(
                "/albums/photos/batch",
                body: BatchBody(albumIds: [albumId], photoIds: photoIds, action: "add")
            )
            resultMessage = "\(photoIds.count) Foto\(photoIds.count == 1 ? "" : "s") hinzugefügt"
        } catch {
            resultMessage = "Fehler: \(error.localizedDescription)"
        }
        isPresented = false
    }

    private struct BatchBody: Encodable {
        let albumIds: [Int]
        let photoIds: [Int]
        let action: String
    }
    private struct BoolResponse: Decodable { let success: Bool }
}

struct AddToAlbumPickerView: View {
    let manager: AddToAlbumManager
    @State private var albums: [Album] = []
    @State private var isLoading = true
    @State private var searchText = ""
    @Environment(\.dismiss) private var dismiss

    private var filteredAlbums: [Album] {
        let base = searchText.isEmpty
            ? albums
            : albums.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
        let pinned = AlbumPinPreferences.pinnedIds
        return base.sorted { a, b in
            let aPinned = pinned.contains(a.id)
            let bPinned = pinned.contains(b.id)
            if aPinned != bPinned { return aPinned }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .listRowSeparator(.hidden)
                } else if albums.isEmpty {
                    ContentUnavailableView {
                        Label("Keine Alben", systemImage: "rectangle.stack")
                    }
                } else {
                    ForEach(filteredAlbums) { album in
                        Button {
                            Task { await manager.addToAlbum(album.id) }
                        } label: {
                            HStack {
                                Text(album.name)
                                    .foregroundStyle(.primary)
                                Spacer()
                                if AlbumPinPreferences.pinnedIds.contains(album.id) {
                                    Image(systemName: "pin.fill")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .disabled(manager.isAdding)
                    }
                }
            }
            .searchable(text: $searchText, prompt: "Album suchen")
            .navigationTitle("\(manager.photoIds.count) Foto\(manager.photoIds.count == 1 ? "" : "s") hinzufügen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
            }
            .overlay {
                if manager.isAdding {
                    ZStack {
                        Color.black.opacity(0.3).ignoresSafeArea()
                        ProgressView("Hinzufügen…")
                            .padding()
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            }
            .task {
                do {
                    let response: ListAlbumsResponse = try await APIClient.shared.get("/albums")
                    albums = response.albums.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
                } catch {}
                isLoading = false
            }
        }
    }
}

// MARK: - Album pin storage

enum AlbumPinPreferences {
    private static let key = "albums.pinnedIds"

    static var pinnedIds: Set<Int> {
        get {
            guard let data = UserDefaults.standard.data(forKey: key),
                  let ids = try? JSONDecoder().decode(Set<Int>.self, from: data) else { return [] }
            return ids
        }
        set {
            let data = try? JSONEncoder().encode(newValue)
            UserDefaults.standard.set(data, forKey: key)
        }
    }
}
