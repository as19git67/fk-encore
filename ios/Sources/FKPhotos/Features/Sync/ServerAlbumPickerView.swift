import SwiftUI

/// Picker for selecting a server album (or creating a new one).
/// Designed as a NavigationLink destination — does not wrap its own NavigationStack.
struct ServerAlbumPickerView: View {
    let title: String
    @Binding var selectedAlbumId: Int?
    var disabledIds: Set<Int> = []
    /// Called immediately after a new album is created and before the view
    /// dismisses, so the parent can append it to its own `serverAlbums` state.
    /// Without this the parent's name lookup falls back to "Kein Album" for
    /// the new id until the parent's next /albums refresh — which made the
    /// just-created album appear unassigned in the settings list.
    var onAlbumCreated: (Album) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss

    @State private var albums: [Album] = []
    @State private var isLoading = true
    @State private var searchText = ""
    @State private var showCreateAlert = false
    @State private var newAlbumName = ""
    @State private var creationError: String? = nil
    /// Routes all selection changes through onChange so dismiss() is always
    /// called from the synchronous SwiftUI render cycle, not from async continuations.
    @State private var pendingAlbumId: Int? = nil
    @State private var pendingClearSelection = false

    private var filteredAlbums: [Album] {
        let source = searchText.isEmpty ? albums : albums.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
        // Selected album first, then alphabetically
        return source.sorted {
            let lSelected = $0.id == selectedAlbumId
            let rSelected = $1.id == selectedAlbumId
            if lSelected != rSelected { return lSelected }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    var body: some View {
        List {
            if isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .listRowSeparator(.hidden)
            } else {
                // "No album" option — always visible, not affected by search filter
                Button {
                    pendingClearSelection = true
                } label: {
                    HStack {
                        Text("Kein Album")
                            .foregroundStyle(.primary)
                        Spacer()
                        if selectedAlbumId == nil {
                            Image(systemName: "checkmark")
                                .foregroundStyle(Color.accentColor)
                                .fontWeight(.semibold)
                        }
                    }
                }

                ForEach(filteredAlbums) { album in
                    let isDisabled = disabledIds.contains(album.id)
                    Button {
                        pendingAlbumId = album.id
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(album.name)
                                    .foregroundStyle(.primary)
                                if isDisabled {
                                    Text("Wird heruntergeladen")
                                        .font(.caption)
                                        .foregroundStyle(.orange)
                                }
                            }
                            Spacer()
                            if selectedAlbumId == album.id {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(Color.accentColor)
                                    .fontWeight(.semibold)
                            }
                        }
                    }
                    .disabled(isDisabled)
                }
            }
        }
        .searchable(text: $searchText, prompt: "Album suchen")
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showCreateAlert = true
                } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .task {
            await loadAlbums()
        }
        // Dismiss triggered by selecting an existing album or creating a new one
        .onChange(of: pendingAlbumId) { _, albumId in
            guard let albumId else { return }
            selectedAlbumId = albumId
            dismiss()
        }
        .onChange(of: pendingClearSelection) { _, clear in
            guard clear else { return }
            selectedAlbumId = nil
            dismiss()
        }
        .alert("Neues Album erstellen", isPresented: $showCreateAlert) {
            TextField("Name", text: $newAlbumName)
            Button("Erstellen") {
                let name = newAlbumName
                newAlbumName = ""
                Task { await createAndSelect(name: name) }
            }
            Button("Abbrechen", role: .cancel) { newAlbumName = "" }
        }
        .alert("Fehler", isPresented: .init(
            get: { creationError != nil },
            set: { if !$0 { creationError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(creationError ?? "")
        }
    }

    private func loadAlbums() async {
        do {
            let response: ListAlbumsResponse = try await APIClient.shared.get("/albums")
            albums = response.albums.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        } catch {}
        isLoading = false
    }

    private func createAndSelect(name: String) async {
        struct Body: Encodable { let name: String; let description: String? }
        // POST /albums returns the DB row without aggregate columns
        // (is_shared, newest_photo_at, photo_count, etc.). Decode the
        // populated fields and synthesise the rest so we can construct a
        // full Album object for the parent's lookup state.
        struct CreatedAlbum: Decodable {
            let id: Int
            let user_id: Int
            let name: String
            let description: String?
            let display_mode: String?
            let created_at: String?
            let updated_at: String?
        }
        do {
            let created: CreatedAlbum = try await APIClient.shared.post("/albums", body: Body(name: name, description: nil))
            // Append to our local list and notify the parent so name lookups
            // succeed before the next /albums round-trip completes.
            let album = Album(
                id: created.id,
                user_id: created.user_id,
                name: created.name,
                description: created.description,
                cover_photo_id: nil,
                cover_filename: nil,
                display_mode: created.display_mode ?? "grid",
                newest_photo_at: nil,
                oldest_photo_at: nil,
                photo_count: 0,
                is_shared: false,
                created_at: created.created_at ?? "",
                updated_at: created.updated_at ?? "",
                my_access_level: "owner"
            )
            albums.append(album)
            onAlbumCreated(album)
            // Setting pendingAlbumId triggers .onChange which calls dismiss() on the main render cycle
            pendingAlbumId = created.id
        } catch {
            creationError = error.localizedDescription
        }
    }
}
