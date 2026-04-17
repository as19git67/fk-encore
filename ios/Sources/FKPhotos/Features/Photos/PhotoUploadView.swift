import SwiftUI
import PhotosUI
import Photos
import ImageIO

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
                guard var data = try await item.loadTransferable(type: Data.self) else {
                    await MainActor.run { failedCount += 1 }
                    continue
                }

                // Preserve isFavorite from the Photos library by writing XMP Rating=5
                if let localId = item.itemIdentifier {
                    let result = PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil)
                    if let asset = result.firstObject, asset.isFavorite {
                        data = withXMPRating(data, rating: 5) ?? data
                    }
                }

                let filename = "photo_\(Date().timeIntervalSince1970).jpg"
                let mimeType = "image/jpeg"

                let uploaded = try await APIClient.shared.uploadPhoto(
                    data: data,
                    filename: filename,
                    mimeType: mimeType
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

    /// Writes XMP xmp:Rating into the JPEG/HEIC data without re-encoding pixels.
    /// Returns nil if the operation fails (caller should fall back to original data).
    private func withXMPRating(_ data: Data, rating: Int) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let uti = CGImageSourceGetType(source) else { return nil }

        let metadata = CGImageMetadataCreateMutable()
        CGImageMetadataRegisterNamespaceForPrefix(
            metadata,
            "http://ns.adobe.com/xap/1.0/" as CFString,
            "xmp" as CFString,
            nil
        )
        guard let tag = CGImageMetadataTagCreate(
            "http://ns.adobe.com/xap/1.0/" as CFString,
            "xmp" as CFString,
            "Rating" as CFString,
            .string,
            "\(rating)" as CFTypeRef
        ) else { return nil }
        CGImageMetadataSetTagWithPath(metadata, nil, "xmp:Rating" as CFString, tag)

        let output = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(output, uti, 1, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageDestinationMetadata: metadata,
            kCGImageDestinationMergeMetadata: true
        ]
        guard CGImageDestinationCopyImageSource(dest, source, options as CFDictionary, nil) else { return nil }
        CGImageDestinationFinalize(dest)
        return output as Data
    }
}
