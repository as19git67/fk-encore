import SwiftUI

/// Edit a server album's properties — the iOS counterpart of the web
/// "Album-Einstellungen" dialog: name, description and whether the album opens
/// as a map. Sharing and deleting are reachable from here too, so an album's
/// whole configuration sits in one place.
///
/// Permissions mirror the web app: everyone with write access may edit the
/// properties, sharing needs owner or `write_share`, deleting is owner-only.
struct AlbumSettingsView: View {
    let albumId: Int
    /// Caller's access level ("owner" / "write" / "write_share" / "read"),
    /// forwarded to the share sheet so it knows which levels it may grant.
    let accessLevel: String?
    let canShare: Bool
    let canDelete: Bool
    /// Called after a successful save so the presenting view can update its
    /// copy of the album without a full reload.
    let onSaved: (Saved) -> Void
    /// Called when the user confirmed the deletion; the caller performs it and
    /// decides where to navigate afterwards.
    let onDelete: (() -> Void)?

    struct Saved: Equatable, Sendable {
        let name: String
        let description: String
        let displayMode: String
    }

    @State private var name: String
    @State private var albumDescription: String
    @State private var mapEnabled: Bool
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var showError = false
    @State private var showShareSheet = false
    @State private var showDeleteConfirm = false
    @Environment(\.dismiss) private var dismiss

    init(
        albumId: Int,
        name: String,
        description: String?,
        displayMode: String?,
        accessLevel: String?,
        canShare: Bool,
        canDelete: Bool,
        onSaved: @escaping (Saved) -> Void,
        onDelete: (() -> Void)? = nil
    ) {
        self.albumId = albumId
        self.accessLevel = accessLevel
        self.canShare = canShare
        self.canDelete = canDelete
        self.onSaved = onSaved
        self.onDelete = onDelete
        _name = State(initialValue: name)
        _albumDescription = State(initialValue: description ?? "")
        _mapEnabled = State(initialValue: displayMode == "map")
    }

    private var trimmedName: String {
        AlbumName.normalized(name)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                    TextField("Beschreibung (optional)", text: $albumDescription, axis: .vertical)
                        .lineLimit(1...4)
                } header: {
                    Text("Album")
                }

                Section {
                    Toggle("Karte aktivieren", isOn: $mapEnabled)
                } footer: {
                    Text("Das Album öffnet sich mit der Kartenansicht, sofern die Fotos Orte haben.")
                }

                if canShare {
                    Section {
                        Button {
                            showShareSheet = true
                        } label: {
                            Label("Freigeben…", systemImage: "person.crop.circle.badge.plus")
                        }
                    } footer: {
                        Text("Album für andere Benutzer freigeben oder einen öffentlichen Link erstellen.")
                    }
                }

                if canDelete, onDelete != nil {
                    Section {
                        Button(role: .destructive) {
                            showDeleteConfirm = true
                        } label: {
                            Label("Album löschen", systemImage: "trash")
                        }
                    } footer: {
                        Text("Das Album wird unwiderruflich gelöscht. Die Fotos bleiben erhalten.")
                    }
                }
            }
            .navigationTitle("Album-Einstellungen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Sichern") { Task { await save() } }
                            .disabled(trimmedName.isEmpty)
                    }
                }
            }
            .sheet(isPresented: $showShareSheet) {
                AlbumShareView(albumId: albumId, albumName: trimmedName, accessLevel: accessLevel)
            }
            .confirmationDialog(
                "Album löschen?",
                isPresented: $showDeleteConfirm,
                titleVisibility: .visible
            ) {
                Button("Löschen", role: .destructive) {
                    onDelete?()
                    dismiss()
                }
                Button("Abbrechen", role: .cancel) {}
            } message: {
                Text("Das Album wird unwiderruflich gelöscht. Die Fotos bleiben erhalten.")
            }
            .alert("Fehler", isPresented: $showError) {
                Button("OK", role: .cancel) { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "")
            }
        }
    }

    private func save() async {
        let newName = trimmedName
        guard !newName.isEmpty else { return }
        isSaving = true
        defer { isSaving = false }

        struct Body: Encodable {
            let id: Int
            let name: String
            let description: String
            let displayMode: String
        }
        // Minimal projection: the update endpoint's album payload carries no
        // `is_shared` / `my_access_level`, so decoding into `Album` would fail.
        struct UpdatedAlbum: Decodable {
            let id: Int
            let name: String
            let description: String?
            let display_mode: String?
        }

        let newDescription = albumDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        let displayMode = mapEnabled ? "map" : "grid"
        do {
            let updated: UpdatedAlbum = try await APIClient.shared.patch(
                "/albums",
                body: Body(id: albumId, name: newName, description: newDescription, displayMode: displayMode)
            )
            onSaved(Saved(
                name: updated.name,
                description: updated.description ?? newDescription,
                displayMode: updated.display_mode ?? displayMode
            ))
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
            showError = true
        }
    }
}
