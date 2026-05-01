import SwiftUI
import PhotosUI
import Photos

struct PhotoUploadView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var selectedItems: [PhotosPickerItem] = []
    @State private var isUploading = false
    @State private var uploadProgress = 0
    @State private var uploadTotal = 0
    @State private var failedCount = 0
    var albumId: Int? = nil
    var onUploadComplete: (() -> Void)?

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                if isUploading {
                    VStack(spacing: 16) {
                        ProgressView(value: Double(uploadProgress), total: Double(max(uploadTotal, 1)))
                            .padding(.horizontal)
                        Text("Hochladen: \(uploadProgress)/\(uploadTotal)")
                            .foregroundStyle(.secondary)
                    }
                } else {
                    PhotosPicker(
                        selection: $selectedItems,
                        maxSelectionCount: 50,
                        matching: .images
                    ) {
                        VStack(spacing: 12) {
                            Image(systemName: "photo.badge.plus")
                                .font(.system(size: 48))
                                .foregroundStyle(.blue)
                            Text("Fotos auswählen")
                                .font(.headline)
                            Text("Bis zu 50 Fotos gleichzeitig")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 48)
                        .background(.quaternary)
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                        .padding(.horizontal)
                    }

                    if !selectedItems.isEmpty {
                        Text("\(selectedItems.count) Foto(s) ausgewählt")
                            .foregroundStyle(.secondary)

                        Button {
                            Task { await uploadPhotos() }
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

                if failedCount > 0 {
                    Text("\(failedCount) Foto(s) konnten nicht hochgeladen werden (bereits vorhanden oder Fehler).")
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
                    Button("Abbrechen") { dismiss() }
                }
            }
        }
    }

    private func uploadPhotos() async {
        isUploading = true
        uploadTotal = selectedItems.count
        uploadProgress = 0
        failedCount = 0

        for item in selectedItems {
            do {
                // Load current (edited) version via PHImageManager when possible.
                // Falls back to loadTransferable when itemIdentifier is unavailable.
                let data: Data
                let mimeType: String
                let isFavorite: Bool
                let capturedAt: Date?

                if let localId = item.itemIdentifier,
                   let asset = PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil).firstObject {
                    (data, mimeType) = try await loadCurrentVersion(of: asset)
                    isFavorite = asset.isFavorite
                    capturedAt = asset.creationDate
                } else {
                    guard let raw = try await item.loadTransferable(type: Data.self) else {
                        await MainActor.run { failedCount += 1 }
                        continue
                    }
                    data = raw
                    mimeType = "image/jpeg"
                    isFavorite = false
                    capturedAt = nil
                }

                let ext = mimeType.contains("heic") ? "heic" : "jpg"
                let filename = "photo_\(Date().timeIntervalSince1970).\(ext)"

                // Resolve target photo id: prefer the freshly-uploaded one,
                // fall back to the existing id surfaced by a 409 duplicate so
                // the user-intended album insertion still happens.
                let targetPhotoId: Int
                do {
                    let uploaded = try await APIClient.shared.uploadPhoto(
                        data: data,
                        filename: filename,
                        mimeType: mimeType,
                        isFavorite: isFavorite,
                        capturedAt: capturedAt
                    )
                    targetPhotoId = uploaded.id
                } catch APIError.duplicatePhoto(let existingPhotoId) {
                    guard let existingPhotoId else {
                        await MainActor.run { failedCount += 1 }
                        continue
                    }
                    targetPhotoId = existingPhotoId
                }

                if let aid = albumId {
                    struct AlbumPhotoBody: Codable { let albumId: Int; let photoId: Int }
                    struct AlbumPhotoResponse: Codable { let success: Bool }
                    _ = try? await APIClient.shared.post(
                        "/albums/photos",
                        body: AlbumPhotoBody(albumId: aid, photoId: targetPhotoId)
                    ) as AlbumPhotoResponse
                }

                await MainActor.run { uploadProgress += 1 }
            } catch {
                await MainActor.run { failedCount += 1 }
            }
        }

        isUploading = false
        onUploadComplete?()
        dismiss()
    }

    /// Loads the current (edited) version of the photo using PHImageManager.
    /// Unedited HEIC photos remain HEIC; edited photos are rendered as JPEG by iOS.
    private func loadCurrentVersion(of asset: PHAsset) async throws -> (Data, String) {
        try await withCheckedThrowingContinuation { continuation in
            let options = PHImageRequestOptions()
            options.version = .current
            options.deliveryMode = .highQualityFormat
            options.isNetworkAccessAllowed = true
            options.isSynchronous = false

            PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) { data, uti, _, info in
                if let error = info?[PHImageErrorKey] as? Error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let data else {
                    continuation.resume(throwing: CancellationError())
                    return
                }
                let mime: String
                if let uti {
                    if uti.contains("heic") || uti.contains("heif") { mime = "image/heic" }
                    else if uti.contains("png")                      { mime = "image/png" }
                    else if uti.contains("tiff")                     { mime = "image/tiff" }
                    else                                             { mime = "image/jpeg" }
                } else {
                    mime = "image/jpeg"
                }
                continuation.resume(returning: (data, mime))
            }
        }
    }
}
