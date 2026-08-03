import SwiftUI

/// Guided flow for "Mit iPhone synchronisieren…" on a f4mil album (issue #812).
///
/// The whole flow lives in one sheet — mode choice, linking, and the initial
/// "upload everything or only new?" question — so both entry points (album list
/// context menu and album detail overflow menu) get identical behaviour from a
/// single `.sheet(item:)`.
struct AlbumSyncLinkSheet: View {
    let album: Album
    /// Whether the caller may write to this album. Explicit because the album
    /// detail endpoint reports access as a coarse role that `Album`'s own
    /// `hasWriteAccess` doesn't understand — see `AlbumSyncLinkModel.link`.
    var hasWriteAccess: Bool
    /// Called after a successful link so the presenting view can refresh.
    var onLinked: (() -> Void)?

    init(album: Album, hasWriteAccess: Bool? = nil, onLinked: (() -> Void)? = nil) {
        self.album = album
        self.hasWriteAccess = hasWriteAccess ?? album.hasWriteAccess
        self.onLinked = onLinked
    }

    @State private var model = AlbumSyncLinkModel()
    @State private var phase: Phase = .chooseMode
    @Environment(\.dismiss) private var dismiss

    private enum Phase: Equatable {
        case chooseMode
        case linked(iosAlbumId: String, albumName: String, assetCount: Int)
        case failed(String)
    }

    var body: some View {
        NavigationStack {
            Group {
                switch phase {
                case .chooseMode:
                    modeChooser
                case .linked(let iosAlbumId, let albumName, let assetCount):
                    initialSyncChoice(iosAlbumId: iosAlbumId, albumName: albumName, assetCount: assetCount)
                case .failed(let message):
                    ContentUnavailableView {
                        Label("Nicht möglich", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    }
                }
            }
            .navigationTitle(album.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(phase == .chooseMode ? "Abbrechen" : "Fertig") { dismiss() }
                }
            }
            .overlay {
                if model.isLinking {
                    ZStack {
                        Color.black.opacity(0.3).ignoresSafeArea()
                        ProgressView("Wird eingerichtet…")
                            .padding()
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            }
        }
    }

    // MARK: - Step 1: mode

    private var modeChooser: some View {
        List {
            Section {
                ForEach(PhotoSyncMode.allChoices, id: \.self) { mode in
                    Button {
                        Task { await performLink(mode: mode) }
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Label(mode.title, systemImage: mode.symbolName)
                                .font(.headline)
                            Text(mode.explanation)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.vertical, 4)
                    }
                    .disabled(model.isLinking)
                }
            } header: {
                Text("Modus")
            } footer: {
                Text("Auf dem iPhone wird ein Album mit dem Namen \"\(AlbumName.normalized(album.name))\" verwendet — vorhandenes Album, sonst neu angelegt.")
            }
        }
    }

    // MARK: - Step 2: initial sync scope

    private func initialSyncChoice(iosAlbumId: String, albumName: String, assetCount: Int) -> some View {
        List {
            Section {
                Button("Alle Fotos hochladen") {
                    // Clearing the watermark makes the next run enumerate the
                    // album from the beginning; already-uploaded photos are
                    // deduplicated server-side.
                    PhotoSyncPreferences.resetAlbumSyncDate(for: iosAlbumId)
                    finish()
                }
                Button("Nur neue ab jetzt") {
                    finish()
                }
            } header: {
                Text("Vorhandene Fotos")
            } footer: {
                Text(initialSyncFooter(albumName: albumName, assetCount: assetCount))
            }
        }
    }

    private func initialSyncFooter(albumName: String, assetCount: Int) -> String {
        let intro = "Das iPhone-Album \"\(albumName)\" ist jetzt mit diesem f4mil-Album verknüpft."
        if assetCount > 0 {
            return "\(intro) Sollen die \(assetCount) bereits enthaltenen Fotos hochgeladen werden oder nur neu hinzugefügte?"
        }
        return "\(intro) Es ist noch leer — Fotos, die du dort hinzufügst, landen im f4mil-Album."
    }

    // MARK: - Actions

    private func performLink(mode: PhotoSyncMode) async {
        switch await model.link(album: album, hasWriteAccess: hasWriteAccess, mode: mode) {
        case .success(let iosAlbumId, let albumName, let assetCount):
            phase = .linked(iosAlbumId: iosAlbumId, albumName: albumName, assetCount: assetCount)
        case .error(let message):
            phase = .failed(message)
        }
    }

    private func finish() {
        onLinked?()
        dismiss()
    }
}

// Mode titles, symbols and explanations live on `PhotoSyncMode` itself
// (PhotoSyncPreferences.swift) so every surface names them identically.
