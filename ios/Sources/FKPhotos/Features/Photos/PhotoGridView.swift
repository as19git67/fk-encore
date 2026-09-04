import SwiftUI

struct PhotoGridView: View {
    @State private var viewModel      = PhotosViewModel()
    @State private var filterSort     = FilterSortViewModel(persistenceKey: "photos.filterSort")
    @State private var fullscreenNav: FullscreenNav? = nil
    @State private var selectedIndex  = 0
    @State private var scrollTarget: Int?
    @State private var showUpload     = false
    /// Story-style slideshow over the photos on screen (or the selected ones).
    @State private var showSlideshow = false
    @State private var isSelecting    = false
    @State private var selectedIds: Set<Int> = []
    @State private var shareManager   = PhotoShareManager()
    @State private var addToAlbum     = AddToAlbumManager()
    @State private var itemFrames: [Int: CGRect] = [:]

    private let columns = [
        GridItem(.adaptive(minimum: 100, maximum: 150), spacing: 2)
    ]

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                if viewModel.isLoading && viewModel.photos.isEmpty {
                    ProgressView("Fotos laden...")
                        .padding(.top, 100)
                } else if let error = viewModel.errorMessage, viewModel.photos.isEmpty {
                    ContentUnavailableView {
                        Label("Fehler", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Erneut versuchen") {
                            Task { await viewModel.loadPhotos() }
                        }
                    }
                } else if viewModel.photos.isEmpty {
                    ContentUnavailableView {
                        Label("Keine Fotos", systemImage: "photo.on.rectangle.angled")
                    } description: {
                        Text("Lade Fotos hoch, um loszulegen.")
                    }
                } else {
                    LazyVGrid(columns: columns, spacing: 2) {
                        ForEach(viewModel.photos) { photo in
                            PhotoThumbnailView(filename: photo.filename, autoCrop: photo.auto_crop, photoId: photo.id)
                                .overlay(alignment: .topLeading) {
                                    if isSelecting {
                                        SelectionCheckmark(isSelected: selectedIds.contains(photo.id))
                                            .padding(4)
                                    }
                                }
                                .contentShape(Rectangle())
                                .onTapGesture {
                                    if isSelecting {
                                        toggleSelection(photo.id)
                                    } else {
                                        selectedIndex = viewModel.photos.firstIndex(where: { $0.id == photo.id }) ?? 0
                                        fullscreenNav = FullscreenNav(startIndex: selectedIndex)
                                    }
                                }
                                .onLongPressGesture {
                                    if !isSelecting {
                                        isSelecting = true
                                        selectedIds = [photo.id]
                                    }
                                }
                                .reportPhotoFrame(id: photo.id, space: "photoGrid")
                                .id(photo.id)
                        }
                    }
                    .padding(.horizontal, 2)
                    .coordinateSpace(name: "photoGrid")
                    .onPreferenceChange(PhotoFramePreference.self) { itemFrames = $0 }
                    .simultaneousGesture(isSelecting ? dragSelectGesture : nil)
                }
            }
            .onChange(of: scrollTarget) { _, id in
                guard let id else { return }
                withAnimation {
                    proxy.scrollTo(id, anchor: .center)
                }
                scrollTarget = nil
            }
        }
        .navigationTitle(isSelecting ? "\(selectedIds.count) ausgewählt" : "Fotos")
        .toolbar {
            if isSelecting {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") {
                        isSelecting = false
                        selectedIds = []
                    }
                }
                // Titled labels, not bare images: in selection mode the title
                // („N ausgewählt") plus these leaves too little room, so the
                // system folds them into its „…" overflow menu — and a menu
                // row built from an `Image` alone has nothing to draw, which
                // is why tapping the three dots looked like it did nothing.
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        addToAlbum.present(photoIds: selectedIds)
                    } label: {
                        Label("Zu Album hinzufügen", systemImage: "rectangle.stack.badge.plus")
                    }
                    .disabled(selectedIds.isEmpty)
                    Button {
                        let filenames = viewModel.photos.filter { selectedIds.contains($0.id) }.map(\.filename)
                        Task { await shareManager.share(filenames: filenames) }
                    } label: {
                        Label("Teilen", systemImage: "square.and.arrow.up")
                    }
                    .disabled(selectedIds.isEmpty || shareManager.isLoading)
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
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        isSelecting = true
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
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showUpload = true
                    } label: {
                        Image(systemName: "photo.badge.plus")
                    }
                }
            }
        }
        .fullScreenCover(isPresented: $showSlideshow) {
            PhotoSlideshowView(photos: slideshowPhotos, title: "Fotos")
        }
        .sheet(isPresented: $showUpload) {
            PhotoUploadView {
                Task { await viewModel.loadPhotos(filter: filterSort.appliedFilter, sort: filterSort.appliedSort) }
            }
        }
        .sheet(isPresented: $filterSort.isMenuPresented) {
            FilterSortMenuView(viewModel: filterSort)
                .presentationDetents([.medium, .large])
        }
        .navigationDestination(item: $fullscreenNav) { _ in
            PhotoFullscreenView(
                photos: viewModel.photos,
                currentIndex: $selectedIndex,
                onPhotoRemoved: { id in viewModel.photos.removeAll { $0.id == id } }
            )
        }
        .onChange(of: fullscreenNav) { _, nav in
            if nav == nil, !viewModel.photos.isEmpty {
                let idx = min(selectedIndex, viewModel.photos.count - 1)
                let photoId = viewModel.photos[idx].id
                // Delay until the dismiss animation completes so the grid is fully visible.
                Task {
                    try? await Task.sleep(for: .milliseconds(400))
                    scrollTarget = photoId
                }
            }
        }
        .refreshable {
            await viewModel.loadPhotos(filter: filterSort.appliedFilter, sort: filterSort.appliedSort)
        }
        .task(id: filterSort.applyToken) {
            await viewModel.loadPhotos(filter: filterSort.appliedFilter, sort: filterSort.appliedSort)
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
            isSelecting = false
            selectedIds = []
            addToAlbum.resultMessage = nil
        }
    }

    private func toggleSelection(_ id: Int) {
        if selectedIds.contains(id) {
            selectedIds.remove(id)
            if selectedIds.isEmpty { isSelecting = false }
        } else {
            selectedIds.insert(id)
        }
    }

    /// What a slideshow started right now would play: the selected photos
    /// while picking, otherwise everything on screen.
    private var slideshowPhotos: [PhotoWithCuration] {
        guard isSelecting, !selectedIds.isEmpty else { return viewModel.photos }
        return viewModel.photos.filter { selectedIds.contains($0.id) }
    }

    /// A slideshow needs something to advance to, so a single photo does not
    /// offer one.
    private var canStartSlideshow: Bool {
        slideshowPhotos.count > 1
    }

    private struct FullscreenNav: Hashable {
        let startIndex: Int
    }

    /// Paint a selection by dragging across tiles — *after* holding still for
    /// a moment.
    ///
    /// The hold is what makes the grid scrollable while selecting. A bare
    /// `DragGesture` on content inside a `ScrollView` competes with the
    /// scroll view's own pan and wins as soon as it recognises, so selection
    /// mode used to freeze the grid completely: no vertical scrolling at all
    /// while anything was selected. Sequencing the drag behind a long press
    /// means an ordinary swipe is never claimed — it scrolls — and only a
    /// deliberate press-then-drag paints, which is also how Photos does it.
    private var dragSelectGesture: some Gesture {
        LongPressGesture(minimumDuration: 0.25)
            .sequenced(
                before: DragGesture(minimumDistance: 0, coordinateSpace: .named("photoGrid"))
            )
            .onChanged { value in
                guard case .second(_, let drag?) = value else { return }
                for (id, frame) in itemFrames where frame.contains(drag.location) {
                    selectedIds.insert(id)
                }
            }
    }
}

struct PhotoThumbnailView: View {
    @State private var loader: ThumbnailLoader
    let autoCrop: AutoCrop?
    /// nil for a photo known only by filename — a cover row, a face row. Those
    /// keep showing the original; with an id, a photo the user has edited is
    /// shown through their recipe (#1085 §1a).
    let photoId: Int?

    init(filename: String, autoCrop: AutoCrop? = nil, photoId: Int? = nil) {
        _loader = State(initialValue: ThumbnailLoader(filename: filename, photoId: photoId))
        self.autoCrop = autoCrop
        self.photoId = photoId
    }

    /// The AI's focal point is of the original frame, so it is meaningless
    /// once the user has framed the photo themselves — their crop *is* the
    /// answer to „what is this photo of".
    private var effectiveAutoCrop: AutoCrop? {
        loader.isRecipeRendered ? nil : autoCrop
    }

    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fill)
            .overlay {
                GeometryReader { geo in
                    ZStack {
                        if let image = loader.image {
                            focalImageView(image: image, containerSize: geo.size)
                        } else {
                            Rectangle()
                                .fill(.quaternary)
                                .overlay {
                                    if loader.isLoading {
                                        ProgressView()
                                    } else if loader.hasError {
                                        Image(systemName: "exclamationmark.triangle")
                                            .foregroundStyle(.red.opacity(0.6))
                                    } else {
                                        Image(systemName: "photo")
                                            .foregroundStyle(.secondary)
                                    }
                                }
                        }
                    }
                    .frame(width: geo.size.width, height: geo.size.height)
                }
            }
            .clipped()
            .task {
                await loader.load()
            }
    }

    /// Renders the image shifted so the focal point (auto_crop) is centered in the container.
    @ViewBuilder
    private func focalImageView(image: UIImage, containerSize: CGSize) -> some View {
        let S = containerSize.width
        let ar = image.size.width / image.size.height

        // Size the image so its shorter dimension fills S (matching scaledToFill behaviour)
        let renderedW: CGFloat = ar >= 1 ? S * ar : S
        let renderedH: CGFloat = ar >= 1 ? S : S / ar

        // Desired shift to bring focal point to the container centre.
        // Formula: offset = renderedDim × (0.5 − focal), positive = shift image right/down
        let focal = effectiveAutoCrop
        let cropX = CGFloat(focal?.x ?? 0.5)
        let cropY = CGFloat(focal?.y ?? 0.5)
        let rawX = renderedW * (0.5 - cropX)
        let rawY = renderedH * (0.5 - cropY)

        // Clamp so image edges never leave the container bounds
        let maxX = (renderedW - S) / 2
        let maxY = (renderedH - S) / 2
        let offsetX = min(maxX, max(-maxX, rawX))
        let offsetY = min(maxY, max(-maxY, rawY))

        Image(uiImage: image)
            .resizable()
            .frame(width: renderedW, height: renderedH)
            .offset(x: offsetX, y: offsetY)
    }
}

/// Thumbnail for a specific face detection: zooms to face center and draws a yellow bbox.
struct FaceThumbnailView: View {
    @State private var loader: ThumbnailLoader
    let bbox: FaceBBox

    init(filename: String, bbox: FaceBBox) {
        _loader = State(initialValue: ThumbnailLoader(filename: filename))
        self.bbox = bbox
    }

    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fill)
            .overlay {
                GeometryReader { geo in
                    ZStack {
                        if let image = loader.image {
                            faceImageView(image: image, containerSize: geo.size)
                        } else {
                            Rectangle()
                                .fill(.quaternary)
                                .overlay {
                                    if loader.isLoading {
                                        ProgressView()
                                    } else if loader.hasError {
                                        Image(systemName: "exclamationmark.triangle")
                                            .foregroundStyle(.red.opacity(0.6))
                                    } else {
                                        Image(systemName: "photo")
                                            .foregroundStyle(.secondary)
                                    }
                                }
                        }
                    }
                    .frame(width: geo.size.width, height: geo.size.height)
                }
            }
            .clipped()
            .task {
                await loader.load()
            }
    }

    @ViewBuilder
    private func faceImageView(image: UIImage, containerSize: CGSize) -> some View {
        let S = containerSize.width
        let ar = image.size.width / image.size.height
        let renderedW: CGFloat = ar >= 1 ? S * ar : S
        let renderedH: CGFloat = ar >= 1 ? S : S / ar

        // Focal point = face center
        let cropX = CGFloat(bbox.x) + CGFloat(bbox.width) / 2
        let cropY = CGFloat(bbox.y) + CGFloat(bbox.height) / 2
        let rawX = renderedW * (0.5 - cropX)
        let rawY = renderedH * (0.5 - cropY)
        let maxX = (renderedW - S) / 2
        let maxY = (renderedH - S) / 2
        let offsetX = min(maxX, max(-maxX, rawX))
        let offsetY = min(maxY, max(-maxY, rawY))

        // Overlay the bbox directly on the image so it shifts with the image
        let faceW = CGFloat(bbox.width)  * renderedW
        let faceH = CGFloat(bbox.height) * renderedH

        Image(uiImage: image)
            .resizable()
            .frame(width: renderedW, height: renderedH)
            .overlay {
                Rectangle()
                    .stroke(Color.yellow, lineWidth: 2)
                    .frame(width: max(faceW, 4), height: max(faceH, 4))
                    .position(
                        x: cropX * renderedW,
                        y: cropY * renderedH
                    )
            }
            .offset(x: offsetX, y: offsetY)
    }
}
