import SwiftUI
import PhotosUI

struct PhotoUploadView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var selectedItems: [PhotosPickerItem] = []
    @State private var isUploading = false
    @State private var uploadProgress = 0
    @State private var uploadTotal = 0
    @State private var errorMessage: String?
    var onUploadComplete: (() -> Void)?

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                if isUploading {
                    VStack(spacing: 16) {
                        ProgressView(value: Double(uploadProgress), total: Double(uploadTotal))
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

                if let error = errorMessage {
                    Text(error)
                        .foregroundStyle(.red)
                        .font(.caption)
                        .padding(.horizontal)
                }

                Spacer()
            }
            .padding(.top, 24)
            .navigationTitle("Fotos hochladen")
            .navigationBarTitleDisplayMode(.inline)
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
        errorMessage = nil

        for item in selectedItems {
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else {
                    continue
                }

                let filename = "photo_\(Date().timeIntervalSince1970).jpg"
                let mimeType = "image/jpeg"

                _ = try await APIClient.shared.uploadPhoto(
                    data: data,
                    filename: filename,
                    mimeType: mimeType
                )

                await MainActor.run {
                    uploadProgress += 1
                }
            } catch {
                await MainActor.run {
                    errorMessage = "Fehler beim Hochladen: \(error.localizedDescription)"
                }
            }
        }

        isUploading = false
        if errorMessage == nil {
            onUploadComplete?()
            dismiss()
        }
    }
}
