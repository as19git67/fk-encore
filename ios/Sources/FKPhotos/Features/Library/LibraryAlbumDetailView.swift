import SwiftUI
import Photos

struct LibraryAlbumDetailView: View {
    let album: LibraryBrowserViewModel.IOSAlbum

    @State private var assets: [PHAsset] = []
    @State private var isLoading = true
    @State private var selectedAssetIndex: Int?
    @State private var showFullscreen = false

    private let columns = [
        GridItem(.adaptive(minimum: 100, maximum: 150), spacing: 2)
    ]

    var body: some View {
        Group {
            if isLoading {
                ProgressView("Fotos laden…")
            } else if assets.isEmpty {
                ContentUnavailableView {
                    Label("Keine Fotos", systemImage: "photo")
                } description: {
                    Text("Dieses Album enthält keine Fotos.")
                }
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, spacing: 2) {
                        ForEach(Array(assets.enumerated()), id: \.element.localIdentifier) { index, asset in
                            LibraryPhotoCell(asset: asset)
                                .aspectRatio(1, contentMode: .fill)
                                .clipped()
                                .onTapGesture {
                                    selectedAssetIndex = index
                                    showFullscreen = true
                                }
                        }
                    }
                }
                .fullScreenCover(isPresented: $showFullscreen) {
                    if let startIndex = selectedAssetIndex {
                        LibraryPhotoFullscreenView(
                            assets: assets,
                            currentIndex: Binding(
                                get: { selectedAssetIndex ?? startIndex },
                                set: { selectedAssetIndex = $0 }
                            )
                        )
                    }
                }
            }
        }
        .navigationTitle(album.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .bottomBar) {
                HStack {
                    SyncStatusBadge(status: album.syncStatus)
                    Spacer()
                    Text("\(assets.count) Foto\(assets.count == 1 ? "" : "s")")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .task {
            assets = await loadAssets()
            isLoading = false
        }
    }

    private func loadAssets() async -> [PHAsset] {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let collections = PHAssetCollection.fetchAssetCollections(
                    withLocalIdentifiers: [album.id], options: nil
                )
                guard let collection = collections.firstObject else {
                    continuation.resume(returning: [])
                    return
                }

                let fetchOptions = PHFetchOptions()
                fetchOptions.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
                fetchOptions.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)

                let result = PHAsset.fetchAssets(in: collection, options: fetchOptions)
                var list: [PHAsset] = []
                list.reserveCapacity(result.count)
                result.enumerateObjects { asset, _, _ in
                    list.append(asset)
                }
                continuation.resume(returning: list)
            }
        }
    }
}

// MARK: - Photo Grid Cell

struct LibraryPhotoCell: View {
    let asset: PHAsset
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Rectangle()
                    .fill(.quaternary)
            }
        }
        .task(id: asset.localIdentifier) {
            image = await loadThumbnail()
        }
    }

    private func loadThumbnail() async -> UIImage? {
        await withCheckedContinuation { continuation in
            let options = PHImageRequestOptions()
            options.deliveryMode = .opportunistic
            options.resizeMode = .fast
            options.isSynchronous = true

            DispatchQueue.global(qos: .userInitiated).async {
                var result: UIImage?
                PHImageManager.default().requestImage(
                    for: asset,
                    targetSize: CGSize(width: 200, height: 200),
                    contentMode: .aspectFill,
                    options: options
                ) { image, _ in
                    result = image
                }
                continuation.resume(returning: result)
            }
        }
    }
}
