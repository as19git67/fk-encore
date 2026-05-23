import SwiftUI

struct PhotoGridView: View {
    @State private var viewModel      = PhotosViewModel()
    @State private var filterSort     = FilterSortViewModel(persistenceKey: "photos.filterSort")
    @State private var isFullscreenPresented = false
    @State private var selectedIndex  = 0
    @State private var scrollTarget: Int?
    @State private var showUpload     = false
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
                            PhotoThumbnailView(filename: photo.filename, autoCrop: photo.auto_crop)
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
                                        isFullscreenPresented = true
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
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        addToAlbum.present(photoIds: selectedIds)
                    } label: {
                        Image(systemName: "rectangle.stack.badge.plus")
                    }
                    .disabled(selectedIds.isEmpty)
                    Button {
                        let filenames = viewModel.photos.filter { selectedIds.contains($0.id) }.map(\.filename)
                        Task { await shareManager.share(filenames: filenames) }
                    } label: {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .disabled(selectedIds.isEmpty || shareManager.isLoading)
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
                    Button {
                        showUpload = true
                    } label: {
                        Image(systemName: "photo.badge.plus")
                    }
                }
            }
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
        .navigationDestination(isPresented: $isFullscreenPresented) {
            PhotoFullscreenView(photos: viewModel.photos, currentIndex: $selectedIndex)
        }
        .onChange(of: isFullscreenPresented) { _, isPresented in
            if !isPresented, !viewModel.photos.isEmpty {
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

    private var dragSelectGesture: some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .named("photoGrid"))
            .onChanged { value in
                let point = value.location
                for (id, frame) in itemFrames where frame.contains(point) {
                    selectedIds.insert(id)
                }
            }
    }
}

struct PhotoThumbnailView: View {
    @State private var loader: ThumbnailLoader
    let autoCrop: AutoCrop?

    init(filename: String, autoCrop: AutoCrop? = nil) {
        _loader = State(initialValue: ThumbnailLoader(filename: filename))
        self.autoCrop = autoCrop
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
        let cropX = CGFloat(autoCrop?.x ?? 0.5)
        let cropY = CGFloat(autoCrop?.y ?? 0.5)
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
