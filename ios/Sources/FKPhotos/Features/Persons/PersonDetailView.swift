import SwiftUI

struct PersonDetailView: View {
    let personId: Int
    @State private var personName: String = ""
    @State private var faces: [Face] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var selectedPhoto: PhotoWithCuration?
    @State private var selectedFaceBBox: FaceBBox?
    @State private var isIgnoringAll = false

    private var isUnnamed: Bool { personName == "Unbenannt" }

    private struct EmptyBody: Codable {}
    private struct IgnoreResult: Codable { let success: Bool }

    private let columns = [
        GridItem(.adaptive(minimum: 100, maximum: 150), spacing: 2)
    ]

    /// Faces that have an associated photo and are not ignored
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
                            selectedFaceBBox = face.bbox
                            selectedPhoto = makePhotoStub(face)
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
            if isUnnamed && !visibleFaces.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
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
        .fullScreenCover(item: $selectedPhoto) { photo in
            PhotoFullscreenView(photo: photo, faceBBox: selectedFaceBBox)
        }
        .task {
            await loadPerson()
        }
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
