import SwiftUI
import Photos

struct LibraryPhotoFullscreenView: View {
    let assets: [PHAsset]
    @Binding var currentIndex: Int
    @Environment(\.dismiss) private var dismiss
    @State private var showInfo = false
    /// One-off "Einmalig an f4mil senden…" for the photo on screen (issue #812).
    @State private var copyRequest: LibraryPhotoCopyRequest?
    @State private var toastMessage: ToastMessage?

    private var currentAsset: PHAsset? {
        guard assets.indices.contains(currentIndex) else { return nil }
        return assets[currentIndex]
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()

                TabView(selection: $currentIndex) {
                    ForEach(Array(assets.enumerated()), id: \.element.localIdentifier) { index, asset in
                        LibraryFullscreenImage(asset: asset)
                            .tag(index)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .foregroundStyle(.white)
                            .padding(8)
                            .background(.black.opacity(0.5), in: Circle())
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        if let asset = currentAsset {
                            copyRequest = LibraryPhotoCopyRequest(asset)
                        }
                    } label: {
                        Image(systemName: SyncWording.sendOnceSymbol)
                            .foregroundStyle(.white)
                            .padding(8)
                            .background(.black.opacity(0.5), in: Circle())
                    }
                    .disabled(currentAsset == nil)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showInfo.toggle()
                    } label: {
                        Image(systemName: "info.circle")
                            .foregroundStyle(.white)
                            .padding(8)
                            .background(.black.opacity(0.5), in: Circle())
                    }
                }
                ToolbarItem(placement: .bottomBar) {
                    Text("\(currentIndex + 1) / \(assets.count)")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.8))
                }
            }
            .toolbarBackground(.hidden, for: .navigationBar)
            .toolbarBackground(.hidden, for: .bottomBar)
            .sheet(isPresented: $showInfo) {
                if let asset = currentAsset {
                    LibraryPhotoInfoSheet(asset: asset, serverStatus: serverStatus(for: asset))
                        .presentationDetents([.medium])
                }
            }
            .sheet(item: $copyRequest) { request in
                LibraryPhotoCopySheet(assets: request.assets) { message in
                    toastMessage = message
                }
            }
            .toast($toastMessage)
        }
    }

    private func serverStatus(for asset: PHAsset) -> LibraryPhotoInfoSheet.ServerStatus {
        let syncedState = PhotoSyncPreferences.loadSyncedState()
        if syncedState[asset.localIdentifier] != nil {
            return .uploaded
        }
        let serverMap = PhotoSyncPreferences.loadServerPhotoMap()
        if serverMap.values.contains(asset.localIdentifier) {
            return .uploaded
        }
        return .notUploaded
    }
}

// MARK: - Full-Resolution Image Loader

private struct LibraryFullscreenImage: View {
    let asset: PHAsset
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            } else {
                ProgressView()
                    .tint(.white)
            }
        }
        .task(id: asset.localIdentifier) {
            image = await loadFullImage()
        }
    }

    private func loadFullImage() async -> UIImage? {
        await withCheckedContinuation { continuation in
            let options = PHImageRequestOptions()
            options.deliveryMode = .highQualityFormat
            options.resizeMode = .none
            options.isNetworkAccessAllowed = true
            options.isSynchronous = true

            DispatchQueue.global(qos: .userInitiated).async {
                var result: UIImage?
                PHImageManager.default().requestImage(
                    for: asset,
                    targetSize: PHImageManagerMaximumSize,
                    contentMode: .aspectFit,
                    options: options
                ) { image, _ in
                    result = image
                }
                continuation.resume(returning: result)
            }
        }
    }
}

// MARK: - Info Sheet

struct LibraryPhotoInfoSheet: View {
    let asset: PHAsset
    let serverStatus: ServerStatus

    enum ServerStatus {
        case uploaded
        case notUploaded
    }

    var body: some View {
        NavigationStack {
            List {
                Section("Foto-Info") {
                    if let date = asset.creationDate {
                        LabeledContent("Aufnahmedatum") {
                            Text(date, style: .date)
                        }
                        LabeledContent("Uhrzeit") {
                            Text(date, style: .time)
                        }
                    }
                    LabeledContent("Auflösung") {
                        Text("\(asset.pixelWidth) × \(asset.pixelHeight)")
                    }
                    if asset.isFavorite {
                        LabeledContent("Favorit") {
                            Image(systemName: "heart.fill")
                                .foregroundStyle(.red)
                        }
                    }
                    if let location = asset.location {
                        LabeledContent("Standort") {
                            Text(String(format: "%.4f, %.4f", location.coordinate.latitude, location.coordinate.longitude))
                                .font(.caption)
                        }
                    }
                }

                Section("f4mil Status") {
                    HStack {
                        switch serverStatus {
                        case .uploaded:
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                            Text("In f4mil vorhanden")
                        case .notUploaded:
                            Image(systemName: "icloud.slash")
                                .foregroundStyle(.secondary)
                            Text("Nicht in f4mil")
                        }
                    }
                }
            }
            .navigationTitle("Details")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
