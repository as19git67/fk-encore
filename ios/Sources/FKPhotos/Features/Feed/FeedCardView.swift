import SwiftUI

struct FeedCardView: View {
    let item: FeedPhotoItem
    let isHiddenByMe: Bool
    let onLike: () -> Void
    let onToggleHide: () -> Void

    @State private var showComments = false
    @State private var imageLoader: FeedImageLoader
    /// Full photo for the fullscreen viewer, fetched on demand — the feed item
    /// carries only the handful of fields the card needs.
    @State private var fullscreenPhoto: PhotoWithCuration?
    @State private var isOpeningFullscreen = false

    init(item: FeedPhotoItem, isHiddenByMe: Bool, onLike: @escaping () -> Void, onToggleHide: @escaping () -> Void) {
        self.item = item
        self.isHiddenByMe = isHiddenByMe
        self.onLike = onLike
        self.onToggleHide = onToggleHide
        _imageLoader = State(initialValue: FeedImageLoader(filename: item.filename))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack(spacing: 8) {
                Circle()
                    .fill(Color.accentColor.opacity(0.2))
                    .frame(width: 32, height: 32)
                    .overlay {
                        Text(initials(for: item.owner.name))
                            .font(.caption2.bold())
                            .foregroundStyle(Color.accentColor)
                    }

                VStack(alignment: .leading, spacing: 1) {
                    Text(item.owner.name ?? "Unbekannt")
                        .font(.subheadline.bold())
                    HStack(spacing: 4) {
                        if let album = item.album {
                            Text(album.name)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Text("·")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                        Text(relativeDate(item.lastActivityAt))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            // Photo
            ZStack {
                if let image = imageLoader.image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: .infinity)
                } else {
                    Rectangle()
                        .fill(.quaternary)
                        .aspectRatio(4.0 / 3.0, contentMode: .fit)
                        .overlay {
                            if imageLoader.isLoading {
                                ProgressView()
                            } else {
                                Image(systemName: "photo")
                                    .font(.largeTitle)
                                    .foregroundStyle(.secondary)
                            }
                        }
                }

                if isHiddenByMe {
                    Color.black.opacity(0.45)
                }

                if isOpeningFullscreen {
                    ProgressView()
                        .controlSize(.large)
                        .tint(.white)
                        .shadow(radius: 10)
                }
            }
            .contentShape(Rectangle())
            // Double tap opens the photo fullscreen (where pinch-to-zoom
            // lives); liking stays on the heart button below.
            .onTapGesture(count: 2) {
                Task { await openFullscreen() }
            }

            // Actions
            HStack(spacing: 16) {
                Button(action: onLike) {
                    HStack(spacing: 4) {
                        Image(systemName: item.likedByMe ? "heart.fill" : "heart")
                            .foregroundStyle(item.likedByMe ? .red : .primary)
                        if item.likeCount > 0 {
                            Text("\(item.likeCount)")
                                .font(.subheadline)
                        }
                    }
                }
                .buttonStyle(.plain)

                Button {
                    showComments.toggle()
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "bubble.right")
                        if item.commentCount > 0 {
                            Text("\(item.commentCount)")
                                .font(.subheadline)
                        }
                    }
                }
                .buttonStyle(.plain)

                Button(action: onToggleHide) {
                    Image(systemName: isHiddenByMe ? "hand.thumbsdown.fill" : "hand.thumbsdown")
                        .foregroundStyle(isHiddenByMe ? .gray : .primary)
                }
                .buttonStyle(.plain)

                Spacer()
            }
            .font(.title3)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            // Caption
            if let caption = item.description, !caption.isEmpty {
                HStack(spacing: 4) {
                    Text(item.owner.name ?? "")
                        .font(.subheadline.bold())
                    Text(caption)
                        .font(.subheadline)
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 4)
            }

            // Latest comment preview
            if let comment = item.latestComment {
                HStack(spacing: 4) {
                    Text(comment.author ?? "")
                        .font(.caption.bold())
                    Text(comment.excerpt)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 4)
            }

            // Comment section
            if showComments, let albumId = item.album?.id {
                FeedCommentSection(photoId: item.photoId, albumId: albumId)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
            }
        }
        .opacity(isHiddenByMe ? 0.5 : 1.0)
        // fullScreenCover rather than a navigation push: the feed card is deep
        // inside a LazyVStack, and the viewer wants the whole screen anyway.
        .fullScreenCover(item: $fullscreenPhoto) { photo in
            NavigationStack {
                PhotoFullscreenView(photo: photo)
            }
        }
        .background(Color(.systemBackground))
        .task {
            await imageLoader.load()
        }
    }

    /// Fetch the full photo and present it. The feed item has only a filename
    /// and a few counters, while the viewer needs a real `PhotoWithCuration`.
    @MainActor
    private func openFullscreen() async {
        guard !isOpeningFullscreen else { return }
        isOpeningFullscreen = true
        defer { isOpeningFullscreen = false }
        fullscreenPhoto = try? await PhotoFetch.byId(item.photoId)
    }

    private func initials(for name: String?) -> String {
        guard let name, !name.isEmpty else { return "?" }
        let parts = name.split(separator: " ")
        if parts.count >= 2 {
            return "\(parts[0].prefix(1))\(parts[1].prefix(1))".uppercased()
        }
        return String(name.prefix(2)).uppercased()
    }

    private func relativeDate(_ isoString: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: isoString)
                ?? ISO8601DateFormatter().date(from: isoString) else {
            return ""
        }
        let relative = RelativeDateTimeFormatter()
        relative.unitsStyle = .short
        return relative.localizedString(for: date, relativeTo: Date())
    }
}

@Observable
final class FeedImageLoader: @unchecked Sendable {
    private(set) var image: UIImage?
    private(set) var isLoading = false

    private let filename: String

    init(filename: String) {
        self.filename = filename
    }

    @MainActor
    func load() async {
        guard !isLoading, image == nil else { return }

        let cacheKey = "feed-\(filename)"
        if let cached = await ImageCache.shared.image(forKey: cacheKey) {
            image = cached
            return
        }

        isLoading = true
        defer { isLoading = false }

        do {
            let data = try await APIClient.shared.downloadData(
                "/photos/file/\(filename)",
                query: ["w": "1280"]
            )
            guard let loaded = UIImage(data: data) else { return }
            image = loaded
            await ImageCache.shared.store(loaded, forKey: cacheKey)
        } catch {
            // Silently fail
        }
    }
}
