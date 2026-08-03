import SwiftUI
import Photos
import Observation

/// One-off "copy this photo into a f4mil album" from the iOS media library
/// (issue #812, Etappe 5).
///
/// Deliberately **not** a sync relationship. The asset is enqueued once and
/// nothing is written to any of the album-link stores, so no watermark moves and
/// no later run treats the photo's album membership as something to reconcile.
/// In particular the queue item carries no `sourceIosAlbumId`: that field exists
/// to advance a linked album's watermark on successful upload, and doing so here
/// would make a one-off copy silently skip photos for the album's real sync.
///
/// Repeating a copy is harmless: the server deduplicates by `full_hash`, so a
/// second copy of the same photo just attaches the existing server photo to the
/// chosen album.
@Observable
final class LibraryPhotoCopyModel {
    var albums: [Album] = []
    var isLoading = false
    var isCopying = false
    var errorMessage: String?

    /// Albums a photo may be copied into: everything the user can write to.
    /// Read-only shares are filtered out because the server rejects the album
    /// attachment — offering them would upload a photo that lands nowhere.
    static func copyTargets(from albums: [Album]) -> [Album] {
        albums
            .filter(\.hasWriteAccess)
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response: ListAlbumsResponse = try await APIClient.shared.get("/albums")
            albums = Self.copyTargets(from: response.albums)
        } catch {
            errorMessage = "Alben konnten nicht geladen werden: \(error.localizedDescription)"
        }
    }

    /// Enqueues `assets` for a one-time upload into `album`. Returns the number
    /// of assets that could be prepared; the rest failed to hash (typically an
    /// iCloud original that isn't on the device) and are reported to the caller.
    @discardableResult
    func copy(_ assets: [PHAsset], to album: Album) async -> Int {
        isCopying = true
        defer { isCopying = false }

        var enqueued = 0
        for asset in assets {
            guard let item = await AssetUploadEnqueuer.makeQueueItem(
                for: asset,
                targetAlbumIds: [album.id]
            ) else { continue }
            await UploadQueue.shared.enqueue(item)
            enqueued += 1
        }

        guard enqueued > 0 else {
            errorMessage = assets.count == 1
                ? "Das Foto konnte nicht gelesen werden. Liegt es nur in iCloud?"
                : "Keines der Fotos konnte gelesen werden. Liegen sie nur in iCloud?"
            return 0
        }

        // Deliberately an unstructured Task: the sheet is dismissed the moment
        // this returns, and the upload has to outlive it (same reasoning as
        // PhotoUploadView.startDraining).
        Task {
            await BackgroundSyncManager.shared.drainUploadQueue()
        }
        return enqueued
    }
}

/// Sheet payload for the copy flow. `PHAsset` is not `Identifiable`, so
/// `.sheet(item:)` needs this wrapper; it also lets the same sheet serve a
/// single photo and (later) a multi-selection without a second code path.
struct LibraryPhotoCopyRequest: Identifiable {
    let assets: [PHAsset]

    var id: String { assets.map(\.localIdentifier).joined(separator: ",") }

    init(_ assets: [PHAsset]) { self.assets = assets }
    init(_ asset: PHAsset) { self.assets = [asset] }
}

/// Target-album picker for the one-off copy. Kept separate from
/// `AddToAlbumPickerView` (which moves *server* photos between albums) because
/// this one starts from a local `PHAsset` that may not exist server-side yet.
struct LibraryPhotoCopySheet: View {
    let assets: [PHAsset]
    /// Reports the outcome so the presenting view can show a toast.
    var onFinished: (ToastMessage) -> Void

    @State private var model = LibraryPhotoCopyModel()
    @State private var searchText = ""
    @Environment(\.dismiss) private var dismiss

    private var filteredAlbums: [Album] {
        guard !searchText.isEmpty else { return model.albums }
        return model.albums.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
    }

    var body: some View {
        NavigationStack {
            List {
                if model.isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .listRowSeparator(.hidden)
                } else if model.albums.isEmpty {
                    ContentUnavailableView {
                        Label("Kein Ziel-Album", systemImage: "rectangle.stack")
                    } description: {
                        Text("Es gibt kein Album, in das du schreiben darfst.")
                    }
                    .listRowSeparator(.hidden)
                } else {
                    Section {
                        ForEach(filteredAlbums) { album in
                            Button {
                                Task { await copy(to: album) }
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(album.name)
                                            .foregroundStyle(.primary)
                                        if album.my_access_level != "owner" {
                                            Text("geteilt")
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer()
                                    Text("\(album.photo_count)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .disabled(model.isCopying)
                        }
                    } footer: {
                        Text("Einmalige Kopie — das Album wird dadurch nicht dauerhaft synchronisiert.")
                    }
                }
            }
            .searchable(text: $searchText, prompt: "Album suchen")
            .navigationTitle(assets.count == 1 ? "Nach f4mil kopieren" : "\(assets.count) Fotos kopieren")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
            }
            .overlay {
                if model.isCopying {
                    ZStack {
                        Color.black.opacity(0.3).ignoresSafeArea()
                        ProgressView("Wird vorbereitet…")
                            .padding()
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            }
            .task { await model.load() }
        }
    }

    private func copy(to album: Album) async {
        let count = await model.copy(assets, to: album)
        onFinished(Self.resultToast(enqueued: count, requested: assets.count, albumName: album.name)
            ?? .error(model.errorMessage ?? "Kopieren fehlgeschlagen"))
        dismiss()
    }

    /// Feedback for a finished copy, or nil when nothing could be prepared at
    /// all (the caller then reports the model's error).
    ///
    /// A partial result is called out explicitly: with a batch it is entirely
    /// possible that a few photos live only in iCloud and can't be hashed, and
    /// silently uploading 47 of 50 while saying "50 Fotos" would be a lie the
    /// user only discovers much later, if ever.
    static func resultToast(enqueued: Int, requested: Int, albumName: String) -> ToastMessage? {
        guard enqueued > 0 else { return nil }
        if enqueued < requested {
            return .info("\(enqueued) von \(requested) Fotos werden nach \"\(albumName)\" hochgeladen — der Rest ist gerade nicht auf dem Gerät verfügbar")
        }
        return .success(
            enqueued == 1
                ? "Foto wird nach \"\(albumName)\" hochgeladen"
                : "\(enqueued) Fotos werden nach \"\(albumName)\" hochgeladen"
        )
    }
}
