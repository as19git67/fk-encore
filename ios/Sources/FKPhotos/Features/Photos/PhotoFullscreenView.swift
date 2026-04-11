import SwiftUI
import UIKit

// MARK: - Container (supports swipe paging between multiple photos)

struct PhotoFullscreenView: View {
    private let photos: [PhotoWithCuration]
    private let bboxes: [FaceBBox?]
    @Binding private var currentIndex: Int
    @Environment(\.dismiss) private var dismiss
    @State private var showDetails = false
    @State private var currentCurationStatus: CurationStatus

    // Person context (when navigated from PersonDetailView)
    private let personId: Int?
    private let onPersonRenamed: ((String) -> Void)?
    private let onPersonMerged: (() -> Void)?
    @State private var personName: String = ""
    @State private var isRenaming = false
    @State private var newName = ""
    @State private var conflictPerson: PersonWithFaceCount? = nil
    @State private var isMerging = false

    /// Single-photo convenience init (e.g. PersonDetailView).
    init(photo: PhotoWithCuration, faceBBox: FaceBBox? = nil, personId: Int? = nil, initialPersonName: String = "", onPersonRenamed: ((String) -> Void)? = nil, onPersonMerged: (() -> Void)? = nil) {
        self.photos = [photo]
        self.bboxes = [faceBBox]
        _currentIndex = .constant(0)
        _currentCurationStatus = State(initialValue: photo.curation_status)
        self.personId = personId
        _personName = State(initialValue: initialPersonName)
        self.onPersonRenamed = onPersonRenamed
        self.onPersonMerged = onPersonMerged
    }

    /// Multi-photo init for paged navigation (e.g. PhotoGridView).
    init(photos: [PhotoWithCuration], currentIndex: Binding<Int>) {
        self.photos = photos
        self.bboxes = Array(repeating: nil, count: photos.count)
        _currentIndex = currentIndex
        let idx = currentIndex.wrappedValue
        _currentCurationStatus = State(initialValue: photos.indices.contains(idx) ? photos[idx].curation_status : .visible)
        self.personId = nil
        self.onPersonRenamed = nil
        self.onPersonMerged = nil
    }

    private var currentPhoto: PhotoWithCuration? {
        photos.indices.contains(currentIndex) ? photos[currentIndex] : nil
    }

    var body: some View {
        // NavigationStack provides a system toolbar that gets Liquid Glass on iOS 26
        // automatically and places itself correctly below the Dynamic Island.
        NavigationStack {
            TabView(selection: $currentIndex) {
                ForEach(photos.indices, id: \.self) { index in
                    PhotoPageView(
                        photo: photos[index],
                        faceBBox: index < bboxes.count ? bboxes[index] : nil,
                        showDetails: $showDetails,
                        curationStatus: index == currentIndex
                            ? $currentCurationStatus
                            : .constant(photos[index].curation_status)
                    )
                    .tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .background(Color(.systemBackground))
            .ignoresSafeArea()
            .navigationBarTitleDisplayMode(.inline)
            .onChange(of: currentIndex) { _, newIndex in
                if photos.indices.contains(newIndex) {
                    currentCurationStatus = photos[newIndex].curation_status
                }
                withAnimation(.spring(duration: 0.4)) { showDetails = false }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: {
                        Image(systemName: "chevron.left")
                            .fontWeight(.semibold)
                    }
                }
                if personId != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        if isMerging {
                            ProgressView()
                        } else {
                            Button {
                                newName = personName
                                isRenaming = true
                            } label: {
                                Image(systemName: "square.and.pencil")
                            }
                        }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task {
                            guard let photo = currentPhoto else { return }
                            let next: CurationStatus = currentCurationStatus == .hidden ? .visible : .hidden
                            struct Body: Codable { let status: CurationStatus }
                            struct Response: Codable { let success: Bool }
                            _ = try? await APIClient.shared.patch(
                                "/photos/\(photo.id)/curation",
                                body: Body(status: next)
                            ) as Response
                            currentCurationStatus = next
                        }
                    } label: {
                        Image(systemName: currentCurationStatus == .hidden ? "eye.slash" : "eye")
                            .foregroundStyle(currentCurationStatus == .hidden ? Color.red : Color.accentColor)
                    }
                }
                ToolbarItem(placement: .principal) {
                    if let photo = currentPhoto {
                        Button {
                            withAnimation(.spring(duration: 0.4)) { showDetails.toggle() }
                        } label: {
                            VStack(spacing: 0) {
                                if personId != nil {
                                    Text(personName.isEmpty ? "Unbekannt" : personName)
                                        .font(.subheadline).fontWeight(.semibold)
                                        .lineLimit(1)
                                    if let date = chipDate(photo) {
                                        Text(date)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                } else if let loc = photo.location_name ?? photo.location_city {
                                    Text(loc)
                                        .font(.subheadline).fontWeight(.semibold)
                                        .lineLimit(1)
                                    if let date = chipDate(photo) {
                                        Text(date)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                } else if let date = chipDate(photo) {
                                    Text(date)
                                        .font(.subheadline).fontWeight(.semibold)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                ToolbarItem(placement: .bottomBar) {
                    HStack {
                        Button {
                            Task {
                                guard let photo = currentPhoto else { return }
                                let next: CurationStatus = currentCurationStatus == .favorite ? .visible : .favorite
                                struct Body: Codable { let status: CurationStatus }
                                struct Response: Codable { let success: Bool }
                                _ = try? await APIClient.shared.patch(
                                    "/photos/\(photo.id)/curation",
                                    body: Body(status: next)
                                ) as Response
                                currentCurationStatus = next
                            }
                        } label: {
                            Image(systemName: currentCurationStatus == .favorite ? "heart.fill" : "heart")
                                .font(.title2)
                                .foregroundStyle(currentCurationStatus == .favorite ? Color.red : .primary)
                        }

                        Button {
                            withAnimation(.spring(duration: 0.4)) { showDetails.toggle() }
                        } label: {
                            Image(systemName: showDetails ? "info.circle.fill" : "info.circle")
                                .font(.title2)
                                .foregroundStyle(showDetails ? Color.accentColor : .primary)
                        }
                    }
                }
            }
            .toolbarBackground(showDetails ? .visible : .hidden, for: .bottomBar)
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
                    get: { conflictPerson != nil },
                    set: { if !$0 { conflictPerson = nil } }
                ),
                titleVisibility: .visible
            ) {
                if let conflict = conflictPerson {
                    Button("Zusammenführen mit \"\(conflict.name)\"") {
                        Task { await mergeInto(conflict) }
                    }
                }
                Button("Abbrechen", role: .cancel) { conflictPerson = nil }
            } message: {
                if let conflict = conflictPerson {
                    Text("\"\(conflict.name)\" existiert bereits. Die Fotos dieser Person werden zu \"\(conflict.name)\" verschoben.")
                }
            }
        }
    }

    // MARK: - Person rename/merge

    private struct ListPersonsResponse: Codable { let persons: [PersonWithFaceCount] }
    private struct RenameBody: Codable { let name: String }
    private struct MergeBody: Codable { let sourceIds: [Int]; let targetId: Int }
    private struct MergeResponse: Codable { let success: Bool }

    private func submitRename() async {
        guard let pid = personId else { return }
        let name = newName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, name.lowercased() != "unbenannt" else { return }

        if let response = try? await APIClient.shared.get("/persons") as ListPersonsResponse,
           let existing = response.persons.first(where: {
               $0.name.lowercased() == name.lowercased() && $0.id != pid
           }) {
            conflictPerson = existing
            return
        }

        await renamePerson(pid: pid, to: name)
    }

    private func renamePerson(pid: Int, to name: String) async {
        struct PersonResponse: Codable { let id: Int; let name: String }
        do {
            let _: PersonResponse = try await APIClient.shared.patch("/persons/\(pid)", body: RenameBody(name: name))
            personName = name
            onPersonRenamed?(name)
        } catch {}
    }

    private func mergeInto(_ target: PersonWithFaceCount) async {
        guard let pid = personId else { return }
        isMerging = true
        conflictPerson = nil
        do {
            let _: MergeResponse = try await APIClient.shared.post(
                "/persons/merge",
                body: MergeBody(sourceIds: [pid], targetId: target.id)
            )
            onPersonMerged?()
            dismiss()
        } catch {}
        isMerging = false
    }

    // MARK: - Helpers

    private func chipDate(_ photo: PhotoWithCuration) -> String? {
        guard let d = parseISO(photo.taken_at ?? photo.created_at) else { return nil }
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .none
        return f.string(from: d)
    }

    private func parseISO(_ str: String) -> Date? {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = iso.date(from: str) { return d }
        iso.formatOptions = [.withInternetDateTime]
        if let d = iso.date(from: str) { return d }
        // PostgreSQL timestamp: "2024-03-15 14:30:00[.mmm]" (space, no timezone)
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US_POSIX")
        df.timeZone = TimeZone(identifier: "UTC")
        for fmt in ["yyyy-MM-dd HH:mm:ss.SSS", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd"] {
            df.dateFormat = fmt
            if let d = df.date(from: str) { return d }
        }
        return nil
    }

}

// MARK: - Single page

private struct PhotoPageView: View {
    let photo: PhotoWithCuration
    let faceBBox: FaceBBox?

    @State private var loader: ThumbnailLoader
    @State private var viewModel: PhotoMetadataViewModel
    @Binding var showDetails: Bool
    @Binding var curationStatus: CurationStatus
    @State private var showAllAlbums = false
    @State private var showDatePicker = false
    @State private var editedDate = Date()

    init(photo: PhotoWithCuration, faceBBox: FaceBBox? = nil, showDetails: Binding<Bool>, curationStatus: Binding<CurationStatus>) {
        self.photo = photo
        self.faceBBox = faceBBox
        _loader = State(initialValue: ThumbnailLoader(filename: photo.filename))
        _viewModel = State(initialValue: PhotoMetadataViewModel(photo: photo))
        _showDetails = showDetails
        _curationStatus = curationStatus
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottom) {
                Color(.systemBackground).ignoresSafeArea()

                VStack(spacing: 0) {
                    imageSection(geo: geo)

                    if showDetails {
                        detailsPanel(geo: geo)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                }
            }
        }
        .onChange(of: viewModel.curationStatus) { _, s in
            curationStatus = s
        }
        .onChange(of: curationStatus) { _, s in
            if viewModel.curationStatus != s { viewModel.curationStatus = s }
        }
        .onChange(of: showDetails) { _, isShowing in
            if !isShowing { showAllAlbums = false }
        }
        .task {
            async let img: Void = loader.load()
            async let meta: Void = viewModel.loadAll()
            _ = await (img, meta)
        }
        .sheet(isPresented: $showDatePicker) {
            datePicker
        }
    }

    // MARK: - Image Section

    @ViewBuilder
    private func imageSection(geo: GeometryProxy) -> some View {
        let height: CGFloat = max(0, showDetails
            ? geo.size.height * 0.40
            : geo.size.height)

        ZStack {
            // Photo
            Group {
                if let image = loader.image {
                    ZoomableImageView(image: image)
                        .frame(width: geo.size.width, height: height)
                } else if loader.hasError {
                    Color(.systemBackground)
                        .frame(width: geo.size.width, height: height)
                        .overlay {
                            Image(systemName: "exclamationmark.triangle")
                                .font(.largeTitle)
                                .foregroundStyle(.secondary)
                        }
                } else {
                    Color(.systemBackground)
                        .frame(width: geo.size.width, height: height)
                        .overlay { ProgressView() }
                }
            }

            // Face bbox overlay (when navigated from Persons)
            if let image = loader.image, let bbox = faceBBox, height > 0 {
                let containerW = geo.size.width
                let imageAR = image.size.width / max(image.size.height, 1)
                let containerAR = containerW / height
                // scaledToFit: fit within bounds (letterbox/pillarbox)
                let renderedW: CGFloat = imageAR > containerAR ? containerW : height * imageAR
                let renderedH: CGFloat = imageAR > containerAR ? containerW / imageAR : height
                let originX = (containerW - renderedW) / 2
                let originY = (height - renderedH) / 2
                let faceCenterX = (CGFloat(bbox.x) + CGFloat(bbox.width) / 2) * renderedW + originX
                let faceCenterY = (CGFloat(bbox.y) + CGFloat(bbox.height) / 2) * renderedH + originY
                let faceW = max(CGFloat(bbox.width) * renderedW, 4)
                let faceH = max(CGFloat(bbox.height) * renderedH, 4)
                Rectangle()
                    .stroke(Color.yellow, lineWidth: 2)
                    .frame(width: faceW, height: faceH)
                    .position(x: faceCenterX, y: faceCenterY)
            }
        }
        .frame(height: height)
    }

    // MARK: - Details Panel

    @ViewBuilder
    private func detailsPanel(geo: GeometryProxy) -> some View {
        let height = geo.size.height * 0.60

        ScrollView {
            LazyVStack(spacing: 0) {
                // Date row
                detailRow {
                    HStack {
                        Text(formattedFullDate)
                            .font(.subheadline)
                        Spacer()
                        Button {
                            editedDate = parsedDate ?? Date()
                            showDatePicker = true
                        } label: {
                            Image(systemName: "calendar")
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                // Location
                if let loc = locationText {
                    sectionHeader("Ort")
                    detailRow {
                        Text(loc).font(.subheadline)
                    }
                }

                // AI quality
                if let score = viewModel.photo.ai_quality_score {
                    sectionHeader("Bewertung")
                    detailRow {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 6) {
                                let stars = Int((score * 4).rounded())
                                HStack(spacing: 2) {
                                    ForEach(0..<4, id: \.self) { i in
                                        Image(systemName: i < stars ? "star.fill" : "star")
                                            .font(.caption)
                                            .foregroundStyle(i < stars ? .yellow : .secondary)
                                    }
                                }
                                Text("\(Int((score * 4).rounded())) von 4")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            ProgressView(value: score).tint(.yellow)
                        }
                        .padding(.vertical, 4)
                    }
                }

                // Persons
                if !viewModel.facesLoadFailed {
                    sectionHeader("Personen")
                    if viewModel.isLoadingFaces {
                        detailRow { ProgressView().frame(maxWidth: .infinity) }
                    } else if viewModel.namedFaces.isEmpty {
                        detailRow {
                            Text("Keine Personen erkannt")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        ForEach(viewModel.namedFaces) { face in
                            detailRow {
                                Label(face.personName, systemImage: "person")
                                    .font(.subheadline)
                            }
                        }
                    }
                }

                // Landmarks
                if !viewModel.landmarks.isEmpty {
                    sectionHeader("Sehenswürdigkeiten")
                    ForEach(viewModel.landmarks) { landmark in
                        detailRow {
                            HStack {
                                Label(landmark.label, systemImage: "mappin")
                                    .font(.subheadline)
                                Spacer()
                                Text("\(Int((landmark.confidence * 100).rounded()))%")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                // Albums
                sectionHeader("Alben")
                if viewModel.isLoadingAlbums {
                    detailRow { ProgressView().frame(maxWidth: .infinity) }
                } else {
                    let visibleAlbums = showAllAlbums
                        ? viewModel.sortedAlbums
                        : Array(viewModel.sortedAlbums.prefix(3))
                    ForEach(visibleAlbums) { album in
                        detailRow {
                            Button {
                                viewModel.toggleAlbum(album.id)
                            } label: {
                                HStack {
                                    Image(systemName: viewModel.albumCheckState(for: album.id)
                                          ? "checkmark.square.fill" : "square")
                                        .foregroundStyle(viewModel.albumCheckState(for: album.id)
                                                         ? Color.accentColor : .secondary)
                                    Text(album.name)
                                        .foregroundStyle(.primary)
                                    Spacer()
                                }
                                .font(.subheadline)
                            }
                        }
                    }
                    if viewModel.sortedAlbums.count > 3 {
                        detailRow {
                            Button {
                                withAnimation { showAllAlbums.toggle() }
                            } label: {
                                Text(showAllAlbums
                                     ? "Weniger anzeigen"
                                     : "Mehr anzeigen (\(viewModel.sortedAlbums.count - 3) weitere)")
                                    .font(.subheadline)
                                    .foregroundStyle(Color.accentColor)
                                    .frame(maxWidth: .infinity, alignment: .center)
                            }
                        }
                    }
                    if viewModel.hasPendingAlbumChanges {
                        detailRow {
                            Button {
                                Task { await viewModel.saveAlbumChanges() }
                            } label: {
                                if viewModel.isSavingAlbums {
                                    ProgressView().frame(maxWidth: .infinity)
                                } else {
                                    Text("Speichern")
                                        .frame(maxWidth: .infinity, alignment: .center)
                                        .foregroundStyle(Color.accentColor)
                                        .font(.subheadline)
                                }
                            }
                            .disabled(viewModel.isSavingAlbums)
                        }
                    }
                }

                // File info
                sectionHeader("Datei")
                detailRow {
                    LabeledContent("Name", value: viewModel.photo.original_name)
                        .font(.subheadline)
                }
                detailRow {
                    LabeledContent("Größe", value: formatBytes(viewModel.photo.size))
                        .font(.subheadline)
                }
            }
        }
        .background(Color(.systemGroupedBackground))
        .frame(height: max(height, 0))
    }


    // MARK: - Date Picker Sheet

    private var datePicker: some View {
        NavigationStack {
            DatePicker(
                "Datum und Uhrzeit",
                selection: $editedDate,
                displayedComponents: [.date, .hourAndMinute]
            )
            .datePickerStyle(.graphical)
            .padding()
            .navigationTitle("Datum ändern")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Abbrechen") { showDatePicker = false }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Speichern") {
                        showDatePicker = false
                        Task { await viewModel.updatePhotoDate(editedDate) }
                    }
                    .fontWeight(.semibold)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    // MARK: - Row Helpers

    @ViewBuilder
    private func sectionHeader(_ title: String) -> some View {
        HStack {
            Text(title.uppercased())
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.top, 20)
        .padding(.bottom, 6)
    }

    @ViewBuilder
    private func detailRow<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0) {
            content()
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .background(Color(.systemBackground))
            Divider().padding(.leading, 16)
        }
    }

    // MARK: - Helpers

    private var formattedFullDate: String {
        let raw = viewModel.takenAt ?? viewModel.photo.created_at
        guard let d = parseISO(raw) else { return raw }
        let f = DateFormatter()
        f.dateStyle = .long
        f.timeStyle = .short
        return f.string(from: d)
    }

    private var parsedDate: Date? {
        parseISO(viewModel.takenAt ?? viewModel.photo.created_at)
    }

    private func parseISO(_ str: String) -> Date? {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = iso.date(from: str) { return d }
        iso.formatOptions = [.withInternetDateTime]
        if let d = iso.date(from: str) { return d }
        // PostgreSQL timestamp: "2024-03-15 14:30:00[.mmm]" (space, no timezone)
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US_POSIX")
        df.timeZone = TimeZone(identifier: "UTC")
        for fmt in ["yyyy-MM-dd HH:mm:ss.SSS", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd"] {
            df.dateFormat = fmt
            if let d = df.date(from: str) { return d }
        }
        return nil
    }

    private var locationText: String? {
        let primary = viewModel.photo.location_name ?? viewModel.photo.location_city
        let parts = [primary, viewModel.photo.location_country].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    private func formatBytes(_ bytes: Int) -> String {
        String(format: "%.2f MB", Double(bytes) / 1_048_576)
    }
}
