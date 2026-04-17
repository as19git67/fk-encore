import SwiftUI

struct PhotoGridView: View {
    @State private var viewModel = PhotosViewModel()
    @State private var isFullscreenPresented = false
    @State private var selectedIndex = 0
    @State private var scrollTarget: Int?
    @State private var showUpload = false

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
                            Button {
                                selectedIndex = viewModel.photos.firstIndex(where: { $0.id == photo.id }) ?? 0
                                isFullscreenPresented = true
                            } label: {
                                PhotoThumbnailView(filename: photo.filename, autoCrop: photo.auto_crop)
                            }
                            .buttonStyle(.plain)
                            .id(photo.id)
                        }
                    }
                    .padding(.horizontal, 2)
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
        .navigationTitle("Fotos")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showUpload = true
                } label: {
                    Image(systemName: "photo.badge.plus")
                }
            }
        }
        .sheet(isPresented: $showUpload) {
            PhotoUploadView {
                Task { await viewModel.loadPhotos() }
            }
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
            await viewModel.loadPhotos()
        }
        .task {
            await viewModel.loadPhotos()
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
