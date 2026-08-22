import SwiftUI

struct PhotoDetailView: View {
    let photoId: Int
    @State private var loader: ThumbnailLoader?
    @State private var photo: PhotoWithCuration?
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                // Full-size image
                Group {
                    if let image = loader?.image {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                    } else {
                        Rectangle()
                            .fill(.quaternary)
                            .aspectRatio(4/3, contentMode: .fit)
                            .overlay {
                                if loader?.isLoading == true || (loader == nil && photo == nil) {
                                    ProgressView()
                                } else if loader?.hasError == true {
                                    Image(systemName: "exclamationmark.triangle")
                                        .font(.largeTitle)
                                        .foregroundStyle(.secondary)
                                } else {
                                    Image(systemName: "photo")
                                        .font(.largeTitle)
                                        .foregroundStyle(.secondary)
                                }
                            }
                    }
                }

                // Photo info
                if let photo {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(photo.original_name)
                            .font(.headline)

                        if let takenAt = photo.taken_at {
                            Label(takenAt, systemImage: "calendar")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }

                        if let location = photo.location_name ?? photo.location_city {
                            Label(location, systemImage: "mappin")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }

                        if let lat = photo.latitude, let lng = photo.longitude {
                            Label("\(lat, specifier: "%.4f"), \(lng, specifier: "%.4f")", systemImage: "location")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }

                        HStack {
                            Label(photo.mime_type, systemImage: "doc")
                            Spacer()
                            Label(formatBytes(photo.size), systemImage: "internaldrive")
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)

                        // Curation status
                        HStack(spacing: 12) {
                            curationButton(.favorite, icon: "heart.fill", activeColor: .red)
                            curationButton(.visible, icon: "hand.thumbsdown", activeColor: .green)
                            curationButton(.hidden, icon: "hand.thumbsdown.fill", activeColor: .gray)
                        }
                        .padding(.top, 8)

                        if let score = photo.ai_quality_score {
                            Label("Qualität: \(score, specifier: "%.1f")", systemImage: "sparkles")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.horizontal)
                }
            }
        }
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task {
            await loadPhotoDetails()
            if let filename = photo?.filename {
                let l = ThumbnailLoader(filename: filename)
                loader = l
                await l.load()
            }
        }
    }

    @ViewBuilder
    private func curationButton(_ status: CurationStatus, icon: String, activeColor: Color) -> some View {
        let isActive = photo?.curation_status == status
        Button {
            Task { await setCuration(status) }
        } label: {
            Image(systemName: icon)
                .font(.title2)
                .foregroundStyle(isActive ? activeColor : .secondary)
                .padding(8)
                .background(isActive ? activeColor.opacity(0.15) : .clear)
                .clipShape(Circle())
        }
    }

    private func loadPhotoDetails() async {
        do {
            photo = try await PhotoFetch.byId(photoId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func setCuration(_ status: CurationStatus) async {
        struct Body: Codable { let id: Int; let status: CurationStatus }
        do {
            photo = try await APIClient.shared.put("/photos/curation", body: Body(id: photoId, status: status))
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func formatBytes(_ bytes: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(bytes))
    }
}
