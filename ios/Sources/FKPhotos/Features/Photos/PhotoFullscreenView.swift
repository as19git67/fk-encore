import SwiftUI
import UIKit
import MapKit

// MARK: - Container (supports swipe paging between multiple photos)

struct PhotoFullscreenView: View {
    private let photos: [PhotoWithCuration]
    private let bboxes: [FaceBBox?]
    @Binding private var currentIndex: Int
    @Environment(\.dismiss) private var dismiss
    @State private var showDetails = false
    @State private var curationOverrides: [Int: CurationStatus] = [:]

    // Person context (when navigated from PersonDetailView)
    private let personId: Int?
    private let onPersonRenamed: ((String) -> Void)?
    private let onPersonMerged: (() -> Void)?
    @State private var personName: String = ""
    @State private var isRenaming = false
    @State private var newName = ""
    @State private var conflictPerson: PersonWithFaceCount? = nil
    @State private var showMergeConfirmation = false
    @State private var isMerging = false

    /// Single-photo convenience init (e.g. PersonDetailView).
    init(photo: PhotoWithCuration, faceBBox: FaceBBox? = nil, personId: Int? = nil, initialPersonName: String = "", onPersonRenamed: ((String) -> Void)? = nil, onPersonMerged: (() -> Void)? = nil) {
        self.photos = [photo]
        self.bboxes = [faceBBox]
        _currentIndex = .constant(0)
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
        self.personId = nil
        self.onPersonRenamed = nil
        self.onPersonMerged = nil
    }

    /// Multi-photo init for person context: paged navigation with per-photo face boxes.
    init(photos: [PhotoWithCuration], bboxes: [FaceBBox?], currentIndex: Binding<Int>, personId: Int, initialPersonName: String, onPersonRenamed: ((String) -> Void)? = nil, onPersonMerged: (() -> Void)? = nil) {
        self.photos = photos
        self.bboxes = bboxes.count == photos.count ? bboxes : Array(repeating: nil, count: photos.count)
        _currentIndex = currentIndex
        self.personId = personId
        _personName = State(initialValue: initialPersonName)
        self.onPersonRenamed = onPersonRenamed
        self.onPersonMerged = onPersonMerged
    }

    private var currentPhoto: PhotoWithCuration? {
        photos.indices.contains(currentIndex) ? photos[currentIndex] : nil
    }

    private var currentCuration: CurationStatus {
        guard let photo = currentPhoto else { return .visible }
        return curationOverrides[photo.id] ?? photo.curation_status
    }

    private func curationBinding(for photo: PhotoWithCuration) -> Binding<CurationStatus> {
        Binding(
            get: { curationOverrides[photo.id] ?? photo.curation_status },
            set: { curationOverrides[photo.id] = $0 }
        )
    }

    var body: some View {
        TabView(selection: $currentIndex) {
            ForEach(photos.indices, id: \.self) { index in
                PhotoPageView(
                    photo: photos[index],
                    faceBBox: index < bboxes.count ? bboxes[index] : nil,
                    showDetails: $showDetails,
                    curationStatus: curationBinding(for: photos[index])
                )
                .tag(index)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .background(Color(.systemBackground))
        .background(InteractivePopDisabler())
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .tabBar)
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
                            let next: CurationStatus = currentCuration == .hidden ? .visible : .hidden
                            struct Body: Codable { let status: CurationStatus }
                            struct Response: Codable { let success: Bool }
                            _ = try? await APIClient.shared.patch(
                                "/photos/\(photo.id)/curation",
                                body: Body(status: next)
                            ) as Response
                            curationOverrides[photo.id] = next
                        }
                    } label: {
                        Image(systemName: currentCuration == .hidden ? "hand.thumbsdown.fill" : "hand.thumbsdown")
                            .foregroundStyle(currentCuration == .hidden ? Color.red : Color.accentColor)
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
                                let next: CurationStatus = currentCuration == .favorite ? .visible : .favorite
                                struct Body: Codable { let status: CurationStatus }
                                struct Response: Codable { let success: Bool }
                                _ = try? await APIClient.shared.patch(
                                    "/photos/\(photo.id)/curation",
                                    body: Body(status: next)
                                ) as Response
                                curationOverrides[photo.id] = next
                            }
                        } label: {
                            Image(systemName: currentCuration == .favorite ? "heart.fill" : "heart")
                                .font(.title2)
                                .foregroundStyle(currentCuration == .favorite ? Color.red : .primary)
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
    }

    // MARK: - Swipe-back gesture

    // Disables the UINavigationController's interactive pop gesture while this
    // view is on screen. Without this, the system swipe-right gesture competes
    // with the horizontal TabView pager, and a half-cancelled swipe can leave
    // UIKit's navigation state inconsistent so the next back-button tap is lost.
    private struct InteractivePopDisabler: UIViewControllerRepresentable {
        class Coordinator {
            weak var navigationController: UINavigationController?
        }

        func makeCoordinator() -> Coordinator { Coordinator() }

        func makeUIViewController(context: Context) -> UIViewController { UIViewController() }

        func updateUIViewController(_ vc: UIViewController, context: Context) {
            DispatchQueue.main.async {
                context.coordinator.navigationController = vc.navigationController
                vc.navigationController?.interactivePopGestureRecognizer?.isEnabled = false
            }
        }

        static func dismantleUIViewController(_ vc: UIViewController, coordinator: Coordinator) {
            DispatchQueue.main.async {
                coordinator.navigationController?.interactivePopGestureRecognizer?.isEnabled = true
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
            // Wait for the rename alert to fully dismiss before presenting the
            // confirmation dialog — simultaneous UIAlertController presentations
            // cause unsatisfiable-constraints warnings and a system error alert.
            try? await Task.sleep(nanoseconds: 400_000_000)
            showMergeConfirmation = true
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
    @State private var isEditingDescription = false
    @State private var draftDescription = ""

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
            // Photo (bbox rendered inside ZoomableImageView so it follows zoom/pan)
            Group {
                if let image = loader.image {
                    ZoomableImageView(image: image, faceBBox: faceBBox)
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

                // Description
                sectionHeader("Beschreibung")
                detailRow {
                    if isEditingDescription {
                        HStack(alignment: .top, spacing: 8) {
                            TextField("Beschreibung", text: $draftDescription, axis: .vertical)
                                .font(.subheadline)
                                .lineLimit(3...8)
                            Button("Fertig") {
                                isEditingDescription = false
                                Task { await viewModel.updateDescription(draftDescription) }
                            }
                            .font(.subheadline.bold())
                        }
                    } else {
                        HStack(alignment: .top, spacing: 8) {
                            Text(viewModel.description ?? "Keine Beschreibung")
                                .font(.subheadline)
                                .foregroundStyle(viewModel.description != nil ? .primary : .secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Button {
                                draftDescription = viewModel.description ?? ""
                                isEditingDescription = true
                            } label: {
                                Image(systemName: "square.and.pencil")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                // Tags
                if !viewModel.keywords.isEmpty {
                    sectionHeader("Tags")
                    detailRow {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                ForEach(viewModel.keywords, id: \.self) { tag in
                                    Text(tag)
                                        .font(.caption)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 3)
                                        .background(.quaternary)
                                        .clipShape(Capsule())
                                }
                            }
                        }
                    }
                }

                // Location
                if let lat = viewModel.photo.latitude, let lon = viewModel.photo.longitude {
                    sectionHeader("Ort")
                    let coordinate = CLLocationCoordinate2D(latitude: lat, longitude: lon)
                    Map(initialPosition: .region(MKCoordinateRegion(
                        center: coordinate,
                        span: MKCoordinateSpan(latitudeDelta: 0.005, longitudeDelta: 0.005)
                    ))) {
                        Marker("", coordinate: coordinate).tint(.red)
                    }
                    .frame(height: 160)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 6)
                    if let loc = locationText {
                        detailRow { Text(loc).font(.subheadline) }
                    }
                } else if let loc = locationText {
                    sectionHeader("Ort")
                    detailRow { Text(loc).font(.subheadline) }
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
