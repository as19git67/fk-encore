import SwiftUI

/// A shared album in the feed: one card for the act of sharing instead of
/// every photo in the album as a post of its own. Tapping the pictures or the
/// title opens the album. Same rule and look as `FeedAlbumCard.vue` on the web.
struct FeedAlbumCardView: View {
    let album: FeedAlbumItem

    private var sharedByName: String {
        album.sharedBy.name ?? "Jemand"
    }

    private var countLabel: String {
        album.photoCount == 1 ? "1 Foto" : "\(album.photoCount) Fotos"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack(spacing: 8) {
                Circle()
                    .fill(Color.accentColor.opacity(0.2))
                    .frame(width: 32, height: 32)
                    .overlay {
                        Text(FeedFormat.initials(for: album.sharedBy.name))
                            .font(.caption2.bold())
                            .foregroundStyle(Color.accentColor)
                    }

                VStack(alignment: .leading, spacing: 1) {
                    Text(sharedByName)
                        .font(.subheadline.bold())
                    HStack(spacing: 4) {
                        Text("hat ein Album mit dir geteilt")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("·")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                        Text(FeedFormat.relativeDate(album.lastActivityAt))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            NavigationLink(value: FeedAlbumOpen(id: album.albumId)) {
                VStack(alignment: .leading, spacing: 0) {
                    previews

                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "photo.on.rectangle")
                            .foregroundStyle(Color.accentColor)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(album.name)
                                .font(.headline)
                                .multilineTextAlignment(.leading)
                            Text(countLabel)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            if let description = album.description, !description.isEmpty {
                                Text(description)
                                    .font(.subheadline)
                                    .multilineTextAlignment(.leading)
                                    .padding(.top, 2)
                            }
                        }
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .padding(.top, 4)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Album „\(album.name)“ öffnen, \(countLabel)")
        }
        .background(Color(.systemBackground))
    }

    /// One big picture on top, up to three small ones below it.
    @ViewBuilder
    private var previews: some View {
        let lead = album.previews.first
        let rest = Array(album.previews.dropFirst().prefix(3))
        VStack(spacing: 2) {
            FeedAlbumPreviewImage(filename: lead?.filename)
                .aspectRatio(4.0 / 3.0, contentMode: .fit)
            if !rest.isEmpty {
                HStack(spacing: 2) {
                    ForEach(rest, id: \.photoId) { preview in
                        FeedAlbumPreviewImage(filename: preview.filename)
                            .aspectRatio(1, contentMode: .fit)
                    }
                }
            }
        }
    }
}

/// A square-cropped preview tile; empty album → a placeholder.
private struct FeedAlbumPreviewImage: View {
    let filename: String?
    @State private var loader: FeedImageLoader?

    var body: some View {
        Rectangle()
            .fill(.quaternary)
            .overlay {
                if let image = loader?.image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                } else if loader?.isLoading == true {
                    ProgressView()
                } else {
                    Image(systemName: "photo.on.rectangle")
                        .font(.title)
                        .foregroundStyle(.secondary)
                }
            }
            .clipped()
            .task(id: filename) {
                guard let filename else { return }
                let next = FeedImageLoader(filename: filename)
                loader = next
                await next.load()
            }
    }
}
