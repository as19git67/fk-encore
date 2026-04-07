import SwiftUI
import UIKit

// MARK: - Container (supports swipe paging between multiple photos)

struct PhotoFullscreenView: View {
    private let photos: [PhotoWithCuration]
    private let bboxes: [FaceBBox?]
    @Binding private var currentIndex: Int
    @Environment(\.dismiss) private var dismiss
    @State private var showLocationInfo = false

    /// Single-photo convenience init (e.g. PersonDetailView).
    init(photo: PhotoWithCuration, faceBBox: FaceBBox? = nil) {
        self.photos = [photo]
        self.bboxes = [faceBBox]
        _currentIndex = .constant(0)
    }

    /// Multi-photo init for paged navigation (e.g. PhotoGridView).
    init(photos: [PhotoWithCuration], currentIndex: Binding<Int>) {
        self.photos = photos
        self.bboxes = Array(repeating: nil, count: photos.count)
        _currentIndex = currentIndex
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
                        faceBBox: index < bboxes.count ? bboxes[index] : nil
                    )
                    .tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .background(Color.black)
            .ignoresSafeArea()
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: {
                        Image(systemName: "chevron.left")
                            .fontWeight(.semibold)
                    }
                }
                ToolbarItem(placement: .principal) {
                    if let photo = currentPhoto {
                        Button { showLocationInfo = true } label: {
                            VStack(spacing: 1) {
                                if let loc = photo.location_name ?? photo.location_city {
                                    Text(loc)
                                        .font(.headline)
                                        .lineLimit(1)
                                    if let date = chipDate(photo) {
                                        Text(date).font(.subheadline)
                                    }
                                } else if let date = chipDate(photo) {
                                    Text(date).font(.headline)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .sheet(isPresented: $showLocationInfo) {
            locationInfoSheet
        }
    }

    // MARK: - Helpers

    private func chipDate(_ photo: PhotoWithCuration) -> String? {
        guard let d = parseISO(photo.created_at) else { return nil }
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
        return iso.date(from: str)
    }

    @ViewBuilder
    private var locationInfoSheet: some View {
        let photo = currentPhoto
        let locParts = [photo?.location_name ?? photo?.location_city, photo?.location_country]
            .compactMap { $0 }
        let locText = locParts.isEmpty ? nil : locParts.joined(separator: ", ")
        VStack(alignment: .leading, spacing: 20) {
            if let loc = locText {
                Label(loc, systemImage: "location.fill").font(.subheadline)
            }
            if let date = photo.flatMap({ chipDate($0) }) {
                Label(date, systemImage: "calendar").font(.subheadline)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(24)
        .presentationDetents([.height(180)])
        .presentationDragIndicator(.visible)
    }
}

// MARK: - Single page

private struct PhotoPageView: View {
    let photo: PhotoWithCuration
    let faceBBox: FaceBBox?

    @State private var loader: ThumbnailLoader
    @State private var viewModel: PhotoMetadataViewModel
    @State private var showDetails = false
    @State private var showDatePicker = false
    @State private var editedDate = Date()

    private let toolbarHeight: CGFloat = 60

    init(photo: PhotoWithCuration, faceBBox: FaceBBox? = nil) {
        self.photo = photo
        self.faceBBox = faceBBox
        _loader = State(initialValue: ThumbnailLoader(filename: photo.filename))
        _viewModel = State(initialValue: PhotoMetadataViewModel(photo: photo))
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottom) {
                Color.black.ignoresSafeArea()

                VStack(spacing: 0) {
                    imageSection(geo: geo)

                    if showDetails {
                        detailsPanel(geo: geo)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    }

                    Spacer(minLength: 0)

                    bottomBar
                        .frame(height: toolbarHeight)
                        .frame(maxWidth: .infinity)
                        .background(showDetails ? Color(.systemBackground) : .clear)
                }
            }
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
            : geo.size.height - toolbarHeight)

        ZStack {
            // Photo
            Group {
                if let image = loader.image {
                    ZoomableImageView(image: image)
                        .frame(width: geo.size.width, height: height)
                } else if loader.hasError {
                    Color.black
                        .frame(width: geo.size.width, height: height)
                        .overlay {
                            Image(systemName: "exclamationmark.triangle")
                                .font(.largeTitle)
                                .foregroundStyle(.white.opacity(0.6))
                        }
                } else {
                    Color.black
                        .frame(width: geo.size.width, height: height)
                        .overlay { ProgressView().tint(.white) }
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
        let height = geo.size.height * 0.60 - toolbarHeight

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
                    ForEach(viewModel.sortedAlbums) { album in
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

    // MARK: - Bottom Bar
    //
    // Two visually independent sections at the same height:
    //   • Center: ♡ and ℹ grouped together (compact, only as wide as the icons need)
    //   • Trailing: 👁 in its own section, separated by a Divider

    private var bottomBar: some View {
        HStack(spacing: 0) {
            // ── Center group: favorite + info ──────────────────────────────
            HStack(spacing: 32) {
                Button {
                    Task {
                        let next: CurationStatus = viewModel.curationStatus == .favorite ? .visible : .favorite
                        await viewModel.setCuration(next)
                    }
                } label: {
                    Image(systemName: viewModel.curationStatus == .favorite ? "heart.fill" : "heart")
                        .font(.title2)
                        .foregroundStyle(viewModel.curationStatus == .favorite ? Color.red : toolbarIconColor)
                }

                Button {
                    withAnimation(.spring(duration: 0.4)) { showDetails.toggle() }
                } label: {
                    Image(systemName: showDetails ? "info.circle.fill" : "info.circle")
                        .font(.title2)
                        .foregroundStyle(showDetails ? Color.accentColor : toolbarIconColor)
                }
            }
            .frame(maxWidth: .infinity)   // center within the bar

            // ── Divider ────────────────────────────────────────────────────
            Divider()
                .frame(height: 24)
                .padding(.horizontal, 4)

            // ── Trailing: visibility toggle ────────────────────────────────
            // eye       = currently visible  (tap to hide)
            // eye.slash = currently hidden   (tap to show, shown in red)
            Button {
                Task {
                    let next: CurationStatus = viewModel.curationStatus == .hidden ? .visible : .hidden
                    await viewModel.setCuration(next)
                }
            } label: {
                Image(systemName: viewModel.curationStatus == .hidden ? "eye.slash" : "eye")
                    .font(.title2)
                    .foregroundStyle(viewModel.curationStatus == .hidden ? Color.red : toolbarIconColor)
            }
            .frame(width: 60)
        }
        .padding(.horizontal, 8)
    }

    private var toolbarIconColor: Color {
        showDetails ? .primary : .white
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
        return iso.date(from: str)
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
