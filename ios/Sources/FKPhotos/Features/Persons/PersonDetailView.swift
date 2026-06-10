import SwiftUI

struct PersonDetailView: View {
    let personId: Int
    @State private var personName: String = ""
    @State private var faces: [Face] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var fullscreenIndex: Int = 0
    @State private var fullscreenPhotos: [PhotoWithCuration] = []
    @State private var fullscreenBBoxes: [FaceBBox?] = []
    @State private var fullscreenNav: FullscreenNav? = nil
    @State private var isIgnoringAll = false
    @State private var showIgnoreAllConfirmation = false
    @State private var faceIdToIgnore: Int? = nil

    // Rename / merge state
    @State private var isRenaming = false
    @State private var newName = ""
    @State private var conflictPerson: PersonWithFaceCount? = nil
    @State private var showMergeConfirmation = false
    @State private var isMerging = false

    @State private var filterSort = FilterSortViewModel()
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

    private var displayedFaces: [Face] {
        let f = filterSort.appliedFilter
        let filtered = visibleFaces.filter { face in
            guard let photo = face.photo else { return false }
            // Date range — the only criterion available for FacePhoto
            if f.dateFrom != nil || f.dateTo != nil {
                let isoStr = photo.taken_at ?? photo.created_at
                guard let t = PhotoFilter.parseDate(isoStr) else { return false }
                if let from = f.dateFrom, t < from { return false }
                if let to = f.dateTo {
                    let end = Calendar.current.date(byAdding: .day, value: 1, to: to) ?? to
                    if t >= end { return false }
                }
            }
            return true
        }
        guard !filterSort.appliedSort.isDefault else { return filtered }
        return filtered.sorted { a, b in
            guard let pa = a.photo, let pb = b.photo else { return false }
            let va = PhotoFilter.parseDate(pa.taken_at ?? pa.created_at)?.timeIntervalSince1970 ?? 0
            let vb = PhotoFilter.parseDate(pb.taken_at ?? pb.created_at)?.timeIntervalSince1970 ?? 0
            return filterSort.appliedSort.direction == .desc ? va > vb : va < vb
        }
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
                    ForEach(displayedFaces) { face in
                        Button {
                            let photos = displayedFaces.compactMap { makePhotoStub($0) }
                            let bboxes: [FaceBBox?] = displayedFaces.map { $0.bbox }
                            fullscreenPhotos = photos
                            fullscreenBBoxes = bboxes
                            fullscreenIndex = displayedFaces.firstIndex(where: { $0.id == face.id }) ?? 0
                            fullscreenNav = FullscreenNav(startIndex: fullscreenIndex)
                        } label: {
                            FaceThumbnailView(filename: face.photo!.filename, bbox: face.bbox)
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button(role: .destructive) {
                                faceIdToIgnore = face.id
                            } label: {
                                Label("Ignorieren", systemImage: "person.fill.xmark")
                            }
                        }
                    }
                }
                .padding(.horizontal, 2)
            }
        }
        .navigationTitle(isUnnamed ? "Unbekannt" : personName)
        .navigationBarTitleDisplayMode(.large)
        .sheet(isPresented: $filterSort.isMenuPresented) {
            FilterSortMenuView(viewModel: filterSort, available: [.favorite, .hasGps, .dateRange])
                .presentationDetents([.medium, .large])
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                FilterSortButton(viewModel: filterSort)
            }
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
                        showIgnoreAllConfirmation = true
                    } label: {
                        if isIgnoringAll {
                            ProgressView()
                        } else {
                            Label("Alle ignorieren", systemImage: "person.fill.xmark")
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
            conflictPerson.map { "Mit \"\($0.name)\" zusammenführen?" } ?? "",
            isPresented: Binding(
                get: { showMergeConfirmation },
                set: { if !$0 { showMergeConfirmation = false; conflictPerson = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let conflict = conflictPerson {
                Button("Zusammenführen mit \"\(conflict.name)\"") {
                    Task { await mergeInto(conflict) }
                }
            }
            Button("Abbrechen", role: .cancel) {
                showMergeConfirmation = false
                conflictPerson = nil
            }
        } message: {
            if let conflict = conflictPerson {
                Text("\"\(conflict.name)\" existiert bereits. Die Fotos dieser Person werden zu \"\(conflict.name)\" verschoben.")
            }
        }
        .alert("Alle Gesichter ignorieren?", isPresented: $showIgnoreAllConfirmation) {
            Button("Ignorieren", role: .destructive) {
                Task { await ignoreAllFaces() }
            }
            Button("Abbrechen", role: .cancel) {}
        } message: {
            Text("Alle \(visibleFaces.count) erkannten Gesichter dieser unbekannten Person werden dauerhaft ignoriert. Die Fotos bleiben erhalten.")
        }
        .alert("Gesicht ignorieren?", isPresented: Binding(
            get: { faceIdToIgnore != nil },
            set: { if !$0 { faceIdToIgnore = nil } }
        )) {
            Button("Ignorieren", role: .destructive) {
                if let faceId = faceIdToIgnore {
                    faceIdToIgnore = nil
                    Task { await ignoreFace(faceId: faceId) }
                }
            }
            Button("Abbrechen", role: .cancel) { faceIdToIgnore = nil }
        } message: {
            Text("Diese Gesichtserkennung wird ignoriert und nicht mehr angezeigt. Das Foto bleibt erhalten.")
        }
        .navigationDestination(item: $fullscreenNav) { _ in
            if !fullscreenPhotos.isEmpty {
                PhotoFullscreenView(
                    photos: fullscreenPhotos,
                    bboxes: fullscreenBBoxes,
                    currentIndex: $fullscreenIndex,
                    personId: personId,
                    initialPersonName: personName,
                    onPersonRenamed: { personName = $0 },
                    onPersonMerged: { dismiss() }
                )
            }
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
            // Wait for the rename alert to fully dismiss before presenting the
            // confirmation dialog — presenting two UIAlertControllers simultaneously
            // causes unsatisfiable-constraints warnings and a system error alert.
            try? await Task.sleep(nanoseconds: 400_000_000)
            showMergeConfirmation = true
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
            curation_status: .visible,
            description: nil,
            keywords: nil
        )
    }

    private struct FullscreenNav: Hashable {
        let startIndex: Int
    }
}
