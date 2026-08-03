import SwiftUI
import PhotosUI
import Photos
#if canImport(UIKit)
import UIKit
#endif

/// Manual photo upload into an album (issue #591, Part A).
///
/// Routes every selected photo through the **same** pipeline the automatic
/// folder sync uses (`AssetUploadEnqueuer` → `UploadQueue` →
/// `BackgroundSyncManager.drainUploadQueue`). That single shared path is what
/// makes server-side dedup behave identically for both upload routes:
///  * the pixel `image_data_hash` is computed the same way (decoded pixels of
///    the *edited* resource), so re-uploading the same photo never creates a
///    duplicate, and
///  * the PHAsset `localIdentifier` travels as `X-Asset-Id`, so a later edit
///    (e.g. a crop) re-uploaded here is recognised by the server and *replaces*
///    the existing photo instead of creating a new one.
///
/// Description, favourite and GPS are read by the shared pipeline from the
/// `PHAsset`, so they are always carried with the upload.
struct PhotoUploadView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var selectedItems: [PhotosPickerItem] = []
    /// Local identifiers of photos captured with the camera this session.
    @State private var cameraAssetIds: [String] = []
    @State private var showCamera = false
    @State private var phase: Phase = .idle
    /// Number of items handed to the queue for this upload session.
    @State private var sessionTotal = 0
    /// Queue-item ids created this session, so the progress view only reflects
    /// our own work and ignores unrelated background-sync items.
    @State private var sessionItemIds: Set<UUID> = []
    /// Items that could not be prepared (asset bytes unavailable) before they
    /// ever reached the queue.
    @State private var prepFailures = 0
    @State private var observer = UploadQueueObserver()

    var albumId: Int? = nil
    var onUploadComplete: (() -> Void)?

    private enum Phase { case idle, preparing, uploading, finished }

    private var selectionCount: Int { selectedItems.count + cameraAssetIds.count }

    /// Session queue items still waiting or in flight.
    private var remainingCount: Int {
        observer.items.filter { sessionItemIds.contains($0.id) && ($0.status == .pending || $0.status == .uploading) }.count
    }

    /// Session queue items that failed to upload.
    private var failedCount: Int {
        observer.items.filter { sessionItemIds.contains($0.id) && $0.status == .failed }.count
    }

    /// Completed = enqueued minus still-pending minus failed. Done items are
    /// purged from the queue once a drain finishes, so they fall out of
    /// `remainingCount`/`failedCount` and are counted here.
    private var completedCount: Int {
        max(0, sessionTotal - remainingCount - failedCount)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                switch phase {
                case .idle:
                    selectionArea
                case .preparing:
                    VStack(spacing: 16) {
                        ProgressView()
                        Text("Fotos werden vorbereitet…")
                            .foregroundStyle(.secondary)
                    }
                case .uploading, .finished:
                    progressArea
                }

                if (phase == .idle) && prepFailures > 0 {
                    Text("\(prepFailures) Foto(s) konnten nicht vorbereitet werden.")
                        .foregroundStyle(.orange)
                        .font(.caption)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }

                Spacer()
            }
            .padding(.top, 24)
            .navigationTitle("Fotos hochladen")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if phase == .uploading {
                        // Hand the remaining work to the background queue and
                        // close the dialog (issue #591). The drain task keeps
                        // running; leftover items also drain on the next
                        // foreground resume / background task.
                        Button("In den Hintergrund") {
                            onUploadComplete?()
                            dismiss()
                        }
                    } else {
                        Button("Abbrechen") { dismiss() }
                    }
                }
            }
            .onAppear { observer.startObserving() }
            .onChange(of: remainingCount) { _, newValue in
                if phase == .uploading && newValue == 0 { finishIfComplete() }
            }
            #if os(iOS)
            .fullScreenCover(isPresented: $showCamera) {
                CameraPicker { image in
                    showCamera = false
                    if let image { handleCapturedImage(image) }
                }
                .ignoresSafeArea()
            }
            #endif
        }
    }

    // MARK: - Idle selection UI

    @ViewBuilder
    private var selectionArea: some View {
        // No 50-item cap any more (issue #591): omitting maxSelectionCount lets
        // the system picker select an unlimited number of photos.
        //
        // `photoLibrary: .shared()` is REQUIRED for `PhotosPickerItem.itemIdentifier`
        // to be populated (issue #591). Without it the identifier is always nil,
        // so every selection fell through to `makeFallbackQueueItem` — which loads
        // re-encoded bytes (HEIC → JPEG), drops the caption/favourite (they live on
        // the PHAsset, not in EXIF) and carries no `X-Asset-Id`. The missing asset
        // id also defeated the server's "replace on edit" dedup, so re-uploading an
        // edited photo created a duplicate. Binding the picker to the shared library
        // resolves each item to its PHAsset and routes it through the lossless
        // `AssetUploadEnqueuer.makeQueueItem` path instead.
        PhotosPicker(selection: $selectedItems, matching: .images, photoLibrary: .shared()) {
            pickerTile(
                icon: "photo.badge.plus",
                title: "Fotos auswählen",
                subtitle: "Beliebig viele Fotos"
            )
        }

        #if os(iOS)
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            Button {
                showCamera = true
            } label: {
                pickerTile(icon: "camera", title: "Kamera", subtitle: "Foto direkt aufnehmen")
            }
            .buttonStyle(.plain)
        }
        #endif

        if selectionCount > 0 {
            Text("\(selectionCount) Foto(s) ausgewählt")
                .foregroundStyle(.secondary)

            Button {
                Task { await startUpload() }
            } label: {
                Text("Hochladen")
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(.blue)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .padding(.horizontal)
        }
    }

    private func pickerTile(icon: String, title: String, subtitle: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 48))
                .foregroundStyle(.blue)
            Text(title).font(.headline)
            Text(subtitle).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 32)
        .background(.quaternary)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .padding(.horizontal)
    }

    // MARK: - Progress UI

    @ViewBuilder
    private var progressArea: some View {
        VStack(spacing: 16) {
            ProgressView(value: Double(completedCount), total: Double(max(sessionTotal, 1)))
                .padding(.horizontal)
            Text("Hochladen: \(completedCount)/\(sessionTotal)")
                .foregroundStyle(.secondary)

            if phase == .finished {
                if failedCount > 0 {
                    Text("\(failedCount) Foto(s) konnten nicht hochgeladen werden.")
                        .foregroundStyle(.orange)
                        .font(.caption)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                } else {
                    Label("Fertig", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                }
                Button {
                    onUploadComplete?()
                    dismiss()
                } label: {
                    Text("Schließen")
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(.blue)
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .padding(.horizontal)
            }
        }
    }

    // MARK: - Camera

    #if os(iOS)
    private func handleCapturedImage(_ image: UIImage) {
        Task {
            // Save the capture into the Photos library so it gets a stable
            // PHAsset identifier and flows through the exact same dedup pipeline
            // as library photos.
            if let localId = await saveImageToLibrary(image) {
                await MainActor.run { cameraAssetIds.append(localId) }
            } else {
                await MainActor.run { prepFailures += 1 }
            }
        }
    }

    private func saveImageToLibrary(_ image: UIImage) async -> String? {
        await withCheckedContinuation { continuation in
            var placeholderId: String?
            PHPhotoLibrary.shared().performChanges {
                let request = PHAssetChangeRequest.creationRequestForAsset(from: image)
                placeholderId = request.placeholderForCreatedAsset?.localIdentifier
            } completionHandler: { success, _ in
                continuation.resume(returning: success ? placeholderId : nil)
            }
        }
    }
    #endif

    // MARK: - Upload orchestration

    private func startUpload() async {
        phase = .preparing
        sessionItemIds = []
        sessionTotal = 0
        prepFailures = 0
        let albumTargets = albumId.map { [$0] } ?? []

        var ids: Set<UUID> = []

        // Camera captures (resolved straight from their PHAsset).
        for localId in cameraAssetIds {
            if let asset = PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil).firstObject,
               let item = await AssetUploadEnqueuer.makeQueueItem(for: asset, targetAlbumIds: albumTargets) {
                await UploadQueue.shared.enqueue(item)
                ids.insert(item.id)
            } else {
                prepFailures += 1
            }
        }

        // PhotosPicker selections.
        for picked in selectedItems {
            if let localId = picked.itemIdentifier,
               let asset = PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil).firstObject {
                if let item = await AssetUploadEnqueuer.makeQueueItem(for: asset, targetAlbumIds: albumTargets) {
                    await UploadQueue.shared.enqueue(item)
                    ids.insert(item.id)
                } else {
                    prepFailures += 1
                }
            } else if let item = await makeFallbackQueueItem(from: picked, albumTargets: albumTargets) {
                // Rare: picker item without a library identifier (no Photos
                // authorization). Upload the raw bytes with a pixel-stable hash
                // so dedup still works against other uploads of the same image.
                await UploadQueue.shared.enqueue(item)
                ids.insert(item.id)
            } else {
                prepFailures += 1
            }
        }

        sessionItemIds = ids
        sessionTotal = ids.count

        guard sessionTotal > 0 else {
            phase = .finished
            return
        }

        phase = .uploading
        startDraining()
    }

    /// Builds a queue item for a PhotosPicker selection that has no library
    /// identifier, by loading and persisting its bytes to a temp file.
    private func makeFallbackQueueItem(from picked: PhotosPickerItem, albumTargets: [Int]) async -> UploadQueueItem? {
        guard let data = try? await picked.loadTransferable(type: Data.self) else { return nil }
        let imageDataHash = PhotoHasher.imageDataHash(from: data)
        let fullHash = PhotoHasher.fullHash(
            imageDataHash: imageDataHash, caption: "", isFavorite: false, capturedAtString: ""
        )
        // Derive the real format from the bytes: this path has no PHAsset to
        // ask, and hardcoding JPEG stored PNGs under a .jpg name with a
        // mismatching Content-Type.
        let mimeType = AssetUploadEnqueuer.mimeType(forImageData: data)
        let filename = AssetUploadEnqueuer.filenameMatchingMime(
            "photo_\(Date().timeIntervalSince1970).jpg", mimeType: mimeType
        )
        guard let tempURL = try? await UploadQueue.shared.saveTempFile(data: data, filename: filename) else { return nil }
        return UploadQueueItem(
            tempFileURL: tempURL,
            filename: filename,
            mimeType: mimeType,
            imageDataHash: imageDataHash,
            fullHash: fullHash,
            caption: "",
            isFavorite: false,
            capturedAtString: "",
            targetAlbumIds: albumTargets
        )
    }

    private func startDraining() {
        // Detached from the view's lifetime: the drain (and thus the upload)
        // keeps running if the user taps "In den Hintergrund" and dismisses.
        Task {
            // If a concurrent sync drain holds the lock our items may still be
            // waiting; retry a few times so the dialog actually progresses.
            for _ in 0..<8 {
                await BackgroundSyncManager.shared.drainUploadQueue()
                if await UploadQueue.shared.pendingCount == 0 { break }
                try? await Task.sleep(nanoseconds: 1_500_000_000)
            }
        }
    }

    private func finishIfComplete() {
        guard phase == .uploading, remainingCount == 0 else { return }
        if failedCount == 0 {
            onUploadComplete?()
            dismiss()
        } else {
            // Leave the dialog open so the user sees how many failed.
            phase = .finished
        }
    }
}

#if os(iOS)
/// Thin wrapper around `UIImagePickerController` in camera mode so SwiftUI can
/// offer "take a photo" directly from the upload dialog (issue #591).
struct CameraPicker: UIViewControllerRepresentable {
    /// Called once with the captured image, or `nil` if the user cancelled.
    /// The caller is responsible for dismissing the cover.
    var onComplete: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            parent.onComplete(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.onComplete(nil)
        }
    }
}
#endif
