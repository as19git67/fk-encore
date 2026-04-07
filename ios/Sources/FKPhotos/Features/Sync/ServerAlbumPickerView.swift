import SwiftUI

/// Picker for selecting a server album (or creating a new one).
/// Designed as a NavigationLink destination — does not wrap its own NavigationStack.
struct ServerAlbumPickerView: View {
    let title: String
    @Binding var selectedAlbumId: Int?

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
        if searchText.isEmpty { return albums }
        return albums.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
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
                    Button {
                        pendingAlbumId = album.id
                    } label: {
                        HStack {
                            Text(album.name)
                                .foregroundStyle(.primary)
                            Spacer()
                            if selectedAlbumId == album.id {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(Color.accentColor)
                                    .fontWeight(.semibold)
                            }
                        }
                    }
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
        // POST /albums returns only DB row fields (no is_shared, newest_photo_at etc.),
        // so decode only the id we actually need rather than the full Album type.
        struct CreatedAlbum: Decodable { let id: Int }
        do {
            let created: CreatedAlbum = try await APIClient.shared.post("/albums", body: Body(name: name, description: nil))
            // Setting pendingAlbumId triggers .onChange which calls dismiss() on the main render cycle
            pendingAlbumId = created.id
        } catch {
            creationError = error.localizedDescription
        }
    }
}
