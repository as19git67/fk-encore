import SwiftUI

struct PersonDetailView: View {
    let personId: Int
    @State private var personName: String = ""
    @State private var faces: [Face] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    private struct FaceSelection: Identifiable {
        let photo: PhotoWithCuration
        let bbox: FaceBBox
        var id: Int { photo.id }
    }
    @State private var faceSelection: FaceSelection?
    @State private var isIgnoringAll = false

    // Rename / merge state
    @State private var isRenaming = false
    @State private var newName = ""
    @State private var conflictPerson: PersonWithFaceCount? = nil
    @State private var isMerging = false

    @Environment(\.dismiss) private var dismiss

    private var isUnnamed: Bool { personName == "Unbenannt" }

    private struct EmptyBody: Codable {}
    private struct IgnoreResult: Codable { let success: Bool }
    private struct MergeBody: Codable { let sourceIds: [Int]; let targetId: Int }
    private struct MergeResponse: Codable { let success: Bool }
    private struct RenameBody: Codable { let name: String }

    private let columns = [
        GridItem(.adaptive(minimum: 100, maximum: 150), spacing: 2)
    ]

    private var visibleFaces: [Face] {
        faces.filter { !$0.ignored && $0.photo != nil }
    }

    var body: some View {
        ScrollView {
            if isLoading {
                ProgressView()
                    .padding(.top, 100)
            } else if let error = errorMessage {
                ContentUnavailableView {
                    Label("Fehler", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Erneut versuchen") {
                        Task { await loadPerson() }
                    }
                }
            } else if visibleFaces.isEmpty {
                ContentUnavailableView {
                    Label("Keine Fotos", systemImage: "person.crop.rectangle")
                } description: {
                    Text("Keine Fotos für diese Person gefunden.")
                }
            } else {
                LazyVGrid(columns: columns, spacing: 2) {
                    ForEach(visibleFaces) { face in
                        Button {
                            if let stub = makePhotoStub(face) {
                                faceSelection = FaceSelection(photo: stub, bbox: face.bbox)
                            }
                        } label: {
                            FaceThumbnailView(filename: face.photo!.filename, bbox: face.bbox)
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button(role: .destructive) {
                                Task { await ignoreFace(faceId: face.id) }
                            } label: {
                                Label("Ignorieren", systemImage: "eye.slash")
                            }
                        }
                    }
                }
                .padding(.horizontal, 2)
            }
        }
        .navigationTitle(isUnnamed ? "Unbekannt" : personName)
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if isMerging {
                    ProgressView()
                } else {
                    Button {
                        newName = isUnnamed ? "" : personName
                        isRenaming = true
                    } label: {
                        Image(systemName: "square.and.pencil")
                    }
                }
                if isUnnamed && !visibleFaces.isEmpty {
                    Button {
                        Task { await ignoreAllFaces() }
                    } label: {
                        if isIgnoringAll {
                            ProgressView()
                        } else {
                            Label("Alle ignorieren", systemImage: "eye.slash")
                        }
                    }
                    .disabled(isIgnoringAll)
                    .tint(.red)
                }
            }
        }
        .alert("Umbenennen", isPresented: $isRenaming) {
            TextField("Name eingeben", text: $newName)
                .autocorrectionDisabled()
            Button("Speichern") {
                Task { await submitRename() }
            }
            Button("Abbrechen", role: .cancel) {}
        } message: {
            Text("Gib einen Namen für diese Person ein.")
        }
        .confirmationDialog(
            conflictPerson.map { "Mit \"\($0.name)\" zusammenfuhren?" } ?? "",
            isPresented: Binding(
                get: { conflictPerson != nil },
                set: { if !$0 { conflictPerson = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let conflict = conflictPerson {
                Button("Zusammenfuhren mit \"\(conflict.name)\"") {
                    Task { await mergeInto(conflict) }
                }
            }
            Button("Abbrechen", role: .cancel) { conflictPerson = nil }
        } message: {
            if let conflict = conflictPerson {
                Text("\"\(conflict.name)\" existiert bereits. Die Fotos dieser Person werden zu \"\(conflict.name)\" verschoben.")
            }
        }
        .fullScreenCover(item: $faceSelection) { item in
            PhotoFullscreenView(
                photo: item.photo,
                faceBBox: item.bbox,
                personId: personId,
                initialPersonName: personName,
                onPersonRenamed: { personName = $0 },
                onPersonMerged: { dismiss() }
            )
        }
        .task {
            await loadPerson()
        }
    }

    // MARK: - Actions

    private func submitRename() async {
        let name = newName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, name.lowercased() != "unbenannt" else { return }

        // Check for existing person with the same name
        if let response = try? await APIClient.shared.get("/persons") as ListPersonsResponse,
           let existing = response.persons.first(where: {
               $0.name.lowercased() == name.lowercased() && $0.id != personId
           }) {
            conflictPerson = existing
            return
        }

        await renamePerson(to: name)
    }

    private func renamePerson(to name: String) async {
        do {
            let _: Person = try await APIClient.shared.patch("/persons/\(personId)", body: RenameBody(name: name))
            personName = name
        } catch {}
    }

    private func mergeInto(_ target: PersonWithFaceCount) async {
        isMerging = true
        conflictPerson = nil
        do {
            let _: MergeResponse = try await APIClient.shared.post(
                "/persons/merge",
                body: MergeBody(sourceIds: [personId], targetId: target.id)
            )
            dismiss()
        } catch {}
        isMerging = false
    }

    private func loadPerson() async {
        isLoading = true
        errorMessage = nil
        do {
            let response: PersonDetailsResponse = try await APIClient.shared.get("/persons/\(personId)")
            personName = response.name
            faces = response.faces
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func ignoreFace(faceId: Int) async {
        do {
            let _: IgnoreResult = try await APIClient.shared.post(
                "/faces/\(faceId)/ignore", body: EmptyBody()
            )
            faces.removeAll { $0.id == faceId }
        } catch {}
    }

    private func ignoreAllFaces() async {
        isIgnoringAll = true
        defer { isIgnoringAll = false }
        do {
            let _: IgnoreResult = try await APIClient.shared.post(
                "/persons/\(personId)/ignore", body: EmptyBody()
            )
            faces.removeAll()
        } catch {}
    }

    private func makePhotoStub(_ face: Face) -> PhotoWithCuration? {
        guard let p = face.photo else { return nil }
        return PhotoWithCuration(
            id: p.id,
            user_id: p.user_id,
            filename: p.filename,
            original_name: p.original_name,
            mime_type: "",
            size: 0,
            hash: nil,
            taken_at: p.taken_at,
            created_at: p.created_at,
            latitude: nil,
            longitude: nil,
            location_name: nil,
            location_city: nil,
            location_country: nil,
            ai_quality_score: nil,
            auto_crop: nil,
            curation_status: .visible
        )
    }
}
