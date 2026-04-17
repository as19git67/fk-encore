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
                // Prefer PHAssetResourceManager for original bytes (preserves all metadata).
                // Fall back to loadTransferable when itemIdentifier is unavailable.
                let data: Data
                let mimeType: String
                let isFavorite: Bool

                if let localId = item.itemIdentifier,
                   let asset = PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil).firstObject {
                    let imageData = try await PHAssetLoader.loadOriginal(for: asset)
                    data = imageData.data
                    mimeType = imageData.mimeType
                    isFavorite = asset.isFavorite
                } else {
                    guard let raw = try await item.loadTransferable(type: Data.self) else {
                        await MainActor.run { failedCount += 1 }
                        continue
                    }
                    data = raw
                    mimeType = "image/jpeg"
                    isFavorite = false
                }

                let filename = "photo_\(Date().timeIntervalSince1970).jpg"

                let uploaded = try await APIClient.shared.uploadPhoto(
                    data: data,
                    filename: filename,
                    mimeType: mimeType,
                    isFavorite: isFavorite
                )

                if let aid = albumId {
                    struct AlbumPhotoBody: Codable { let albumId: Int; let photoId: Int }
                    struct AlbumPhotoResponse: Codable { let success: Bool }
                    _ = try? await APIClient.shared.post(
                        "/albums/photos",
                        body: AlbumPhotoBody(albumId: aid, photoId: uploaded.id)
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
}
