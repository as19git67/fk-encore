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

// MARK: - Selection state

/// Multi-select state for a photo grid: which photos are picked, and whether
/// the grid is in selection mode at all.
///
/// A value type so it drops straight into `@State` (same as `AlbumViewFilter`)
/// and so the transition rules — long-press enters selection, deselecting the
/// last photo leaves it again — are unit-testable without a view.
struct PhotoSelection: Equatable, Sendable {
    private(set) var isSelecting = false
    private(set) var ids: Set<Int> = []

    var count: Int { ids.count }
    var isEmpty: Bool { ids.isEmpty }

    func contains(_ id: Int) -> Bool { ids.contains(id) }

    /// Enter selection mode with nothing picked yet — the toolbar entry point.
    mutating func enter() {
        isSelecting = true
        ids = []
    }

    /// Enter selection mode with one photo already picked — the long-press
    /// entry point, where tapping the photo that started it would otherwise
    /// select nothing.
    mutating func begin(with id: Int) {
        isSelecting = true
        ids = [id]
    }

    mutating func cancel() {
        isSelecting = false
        ids = []
    }

    /// Toggle one photo. Deselecting the last one leaves selection mode, so the
    /// grid never sits in an empty selection the user has to cancel by hand.
    mutating func toggle(_ id: Int) {
        if ids.contains(id) {
            ids.remove(id)
            if ids.isEmpty { isSelecting = false }
        } else {
            ids.insert(id)
        }
    }

    /// Drag-to-select: add every photo whose frame contains `point`.
    ///
    /// Additive on purpose — a drag across the grid extends the selection and
    /// never clears it, so a wobbling finger cannot undo what it just picked.
    mutating func selectItems(at point: CGPoint, frames: [Int: CGRect]) {
        for (id, frame) in frames where frame.contains(point) {
            ids.insert(id)
        }
    }

    /// Navigation title while selecting, e.g. "3 ausgewählt".
    var title: String { "\(count) ausgewählt" }
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
