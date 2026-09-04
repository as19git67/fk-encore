import SwiftUI

// MARK: - Timeline root (year grid or filtered flat grid)

struct PhotoTimelineView: View {
    @State private var years: [TimelineYear] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var showUpload = false
    /// Story-style slideshow over the filtered photos (or the selected ones).
    @State private var showSlideshow = false
    @State private var filterSort = FilterSortViewModel(persistenceKey: "photos.filterSort")

    // Used only in filtered mode
    @State private var photosVM = PhotosViewModel()
    @State private var fullscreenIndex = 0
    @State private var fullscreenNav: FullscreenNav? = nil
    @State private var scrollTarget: Int?

    // Multi-select + batch actions in the flat grid (issue #767, Stage 2).
    // Only reachable in filtered mode: the unfiltered timeline shows year
    // tiles, not photos, so there is nothing there to select.
    @State private var selection = PhotoSelection()
    @State private var shareManager = PhotoShareManager()
    @State private var addToAlbum = AddToAlbumManager()
    @State private var itemFrames: [Int: CGRect] = [:]

    private let tileColumns = [
        GridItem(.flexible(), spacing: 2),
        GridItem(.flexible(), spacing: 2),
    ]

    private let gridColumns = [
        GridItem(.adaptive(minimum: 100, maximum: 150), spacing: 2)
    ]

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                if filterSort.activeCount > 0 {
                    filteredContent
                } else {
                    timelineContent
                }
            }
            .onChange(of: scrollTarget) { _, id in
                guard let id else { return }
                withAnimation { proxy.scrollTo(id, anchor: .center) }
                scrollTarget = nil
            }
        }
        .navigationTitle(selection.isSelecting ? selection.title : "Fotos")
        .navigationDestination(item: $fullscreenNav) { _ in
            PhotoFullscreenView(
                photos: photosVM.photos,
                currentIndex: $fullscreenIndex,
                onPhotoRemoved: { id in photosVM.photos.removeAll { $0.id == id } }
            )
        }
        .toolbar {
            if selection.isSelecting {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { selection.cancel() }
                }
                // Titled labels so the system's „…" overflow menu has
                // something to draw — see `PhotoGridView`.
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        addToAlbum.present(photoIds: selection.ids)
                    } label: {
                        Label("Zu Album hinzufügen", systemImage: "rectangle.stack.badge.plus")
                    }
                    .disabled(selection.isEmpty)
                    Button {
                        let filenames = photosVM.photos
                            .filter { selection.contains($0.id) }
                            .map(\.filename)
                        Task { await shareManager.share(filenames: filenames) }
                    } label: {
                        Label("Teilen", systemImage: "square.and.arrow.up")
                    }
                    .disabled(selection.isEmpty || shareManager.isLoading)
                    Button {
                        showSlideshow = true
                    } label: {
                        Label("Diashow", systemImage: "play.rectangle")
                    }
                    .disabled(!canStartSlideshow)
                }
            } else {
                ToolbarItem(placement: .topBarLeading) {
                    FilterSortButton(viewModel: filterSort)
                }
                // Selecting only makes sense over the flat grid; the unfiltered
                // timeline shows year tiles, which are not selectable.
                if filterSort.activeCount > 0 {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            selection.enter()
                        } label: {
                            Image(systemName: "checkmark.circle")
                        }
                    }
                    ToolbarItem(placement: .primaryAction) {
                        Button { showSlideshow = true } label: {
                            Image(systemName: "play.rectangle")
                        }
                        .disabled(!canStartSlideshow)
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { showUpload = true } label: {
                        Image(systemName: "photo.badge.plus")
                    }
                }
            }
        }
        .fullScreenCover(isPresented: $showSlideshow) {
            PhotoSlideshowView(photos: slideshowPhotos, title: "Fotos")
        }
        .sheet(isPresented: $filterSort.isMenuPresented) {
            FilterSortMenuView(viewModel: filterSort)
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $showUpload) {
            PhotoUploadView { Task { await reload() } }
        }
        .onChange(of: fullscreenNav) { _, nav in
            if nav == nil, !photosVM.photos.isEmpty {
                let idx = min(fullscreenIndex, photosVM.photos.count - 1)
                let photoId = photosVM.photos[idx].id
                Task {
                    try? await Task.sleep(for: .milliseconds(400))
                    scrollTarget = photoId
                }
            }
        }
        .refreshable { await reload() }
        .task { await reload() }
        .task(id: filterSort.applyToken) {
            // The photo set is about to change under the selection, and ids
            // picked from the previous result would be invisible but still
            // batched. Drop them.
            selection.cancel()
            if filterSort.activeCount > 0 {
                await photosVM.loadPhotos(filter: filterSort.appliedFilter, sort: filterSort.appliedSort)
            }
        }
        .sheet(isPresented: $shareManager.isPresented) {
            ActivityView(images: shareManager.images)
        }
        .sheet(isPresented: $addToAlbum.isPresented) {
            AddToAlbumPickerView(manager: addToAlbum)
                .presentationDetents([.medium, .large])
        }
        .overlay {
            if shareManager.isLoading {
                ZStack {
                    Color.black.opacity(0.3).ignoresSafeArea()
                    ProgressView("Fotos laden…")
                        .padding()
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                }
            }
        }
        .onChange(of: addToAlbum.resultMessage) { _, message in
            guard message != nil else { return }
            selection.cancel()
            addToAlbum.resultMessage = nil
        }
    }

    /// Drag-to-select, gated behind a hold so the timeline still scrolls
    /// while selecting — see `PhotoGridView.dragSelectGesture` for why.
    private var dragSelectGesture: some Gesture {
        LongPressGesture(minimumDuration: 0.25)
            .sequenced(
                before: DragGesture(minimumDistance: 0, coordinateSpace: .named("timelineGrid"))
            )
            .onChanged { value in
                guard case .second(_, let drag?) = value else { return }
                selection.selectItems(at: drag.location, frames: itemFrames)
            }
    }

    @ViewBuilder
    private var timelineContent: some View {
        if isLoading && years.isEmpty {
            ProgressView()
                .padding(.top, 100)
        } else if let error = errorMessage, years.isEmpty {
            ContentUnavailableView {
                Label("Fehler", systemImage: "exclamationmark.triangle")
            } description: {
                Text(error)
            } actions: {
                Button("Erneut versuchen") { Task { await loadTimeline() } }
            }
        } else if years.isEmpty {
            ContentUnavailableView {
                Label("Keine Fotos", systemImage: "photo.on.rectangle.angled")
            } description: {
                Text("Lade Fotos hoch, um loszulegen.")
            }
        } else {
            LazyVGrid(columns: tileColumns, spacing: 2) {
                ForEach(years) { year in
                    NavigationLink(value: year) {
                        TimelineTileView(
                            title: String(year.year),
                            subtitle: "\(year.count) Fotos",
                            coverFilename: year.cover_filename
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    @ViewBuilder
    private var filteredContent: some View {
        if photosVM.isLoading && photosVM.photos.isEmpty {
            ProgressView("Fotos laden...")
                .padding(.top, 100)
        } else if let error = photosVM.errorMessage, photosVM.photos.isEmpty {
            ContentUnavailableView {
                Label("Fehler", systemImage: "exclamationmark.triangle")
            } description: {
                Text(error)
            } actions: {
                Button("Erneut versuchen") {
                    Task { await photosVM.loadPhotos(filter: filterSort.appliedFilter, sort: filterSort.appliedSort) }
                }
            }
        } else if photosVM.photos.isEmpty {
            ContentUnavailableView {
                Label("Keine Fotos", systemImage: "photo.on.rectangle.angled")
            } description: {
                Text("Keine Fotos entsprechen dem Filter.")
            }
        } else {
            LazyVGrid(columns: gridColumns, spacing: 2) {
                ForEach(photosVM.photos) { photo in
                    PhotoThumbnailView(filename: photo.filename, autoCrop: photo.auto_crop, photoId: photo.id)
                        .overlay(alignment: .topLeading) {
                            if selection.isSelecting {
                                SelectionCheckmark(isSelected: selection.contains(photo.id))
                                    .padding(4)
                            }
                        }
                        .contentShape(Rectangle())
                        .onTapGesture {
                            if selection.isSelecting {
                                selection.toggle(photo.id)
                            } else {
                                fullscreenIndex = photosVM.photos.firstIndex(where: { $0.id == photo.id }) ?? 0
                                fullscreenNav = FullscreenNav(startIndex: fullscreenIndex)
                            }
                        }
                        .onLongPressGesture {
                            if !selection.isSelecting {
                                selection.begin(with: photo.id)
                            }
                        }
                        .reportPhotoFrame(id: photo.id, space: "timelineGrid")
                        .id(photo.id)
                }
            }
            .padding(.horizontal, 2)
            .coordinateSpace(name: "timelineGrid")
            .onPreferenceChange(PhotoFramePreference.self) { itemFrames = $0 }
            .simultaneousGesture(selection.isSelecting ? dragSelectGesture : nil)
        }
    }


    /// What a slideshow started right now would play: the selected photos
    /// while picking, otherwise everything the filter left on screen.
    private var slideshowPhotos: [PhotoWithCuration] {
        guard selection.isSelecting, !selection.isEmpty else { return photosVM.photos }
        return photosVM.photos.filter { selection.contains($0.id) }
    }

    /// A slideshow needs something to advance to, so a single photo does not
    /// offer one.
    private var canStartSlideshow: Bool {
        slideshowPhotos.count > 1
    }

    private func reload() async {
        await loadTimeline()
        if filterSort.activeCount > 0 {
            await photosVM.loadPhotos(filter: filterSort.appliedFilter, sort: filterSort.appliedSort)
        }
    }

    private func loadTimeline() async {
        isLoading = true
        errorMessage = nil
        do {
            let response: PhotoTimelineResponse = try await APIClient.shared.get("/photos/timeline")
            years = response.years
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private struct FullscreenNav: Hashable {
        let startIndex: Int
    }
}

// MARK: - Year detail (month grid)

struct PhotoYearView: View {
    let year: TimelineYear

    private let columns = [
        GridItem(.flexible(), spacing: 2),
        GridItem(.flexible(), spacing: 2),
    ]

    private static let monthFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "de_DE")
        f.dateFormat = "LLLL"
        return f
    }()

    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 2) {
                ForEach(year.months) { month in
                    NavigationLink(value: PhotoMonthRef(year: year.year, month: month.month)) {
                        TimelineTileView(
                            title: Self.monthName(month.month),
                            subtitle: "\(month.count) Fotos",
                            coverFilename: month.cover_filename
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .navigationTitle(String(year.year))
        .navigationBarTitleDisplayMode(.large)
    }

    private static func monthName(_ month: Int) -> String {
        var components = DateComponents()
        components.month = month
        components.day = 1
        components.year = 2000
        guard let date = Calendar.current.date(from: components) else { return "\(month)" }
        return monthFormatter.string(from: date).capitalized
    }
}

// MARK: - Shared tile

struct TimelineTileView: View {
    let title: String
    let subtitle: String
    let coverFilename: String?

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if let filename = coverFilename {
                PhotoThumbnailView(filename: filename)
                    .aspectRatio(1, contentMode: .fill)
            } else {
                Rectangle()
                    .fill(.quaternary)
                    .aspectRatio(1, contentMode: .fill)
                    .overlay {
                        Image(systemName: "photo.on.rectangle.angled")
                            .font(.largeTitle)
                            .foregroundStyle(.secondary)
                    }
            }

            // Gradient scrim
            LinearGradient(
                colors: [.clear, .black.opacity(0.6)],
                startPoint: .center,
                endPoint: .bottom
            )

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.title2).fontWeight(.bold)
                    .foregroundStyle(.white)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.85))
            }
            .padding(10)
        }
        .clipped()
    }
}

// MARK: - Navigation value type

struct PhotoMonthRef: Hashable {
    let year: Int
    let month: Int
}

struct AllPhotosRef: Hashable {}
