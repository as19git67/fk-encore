import SwiftUI

struct FeedCardView: View {
    let item: FeedPhotoItem
    let onLike: () -> Void
    let onHide: () -> Void

    @State private var showComments = false
    @State private var doubleTapScale: CGFloat = 0
    @State private var imageLoader: FeedImageLoader

    init(item: FeedPhotoItem, onLike: @escaping () -> Void, onHide: @escaping () -> Void) {
        self.item = item
        self.onLike = onLike
        self.onHide = onHide
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

                // Double-tap heart animation
                Image(systemName: "heart.fill")
                    .font(.system(size: 80))
                    .foregroundStyle(.white)
                    .shadow(radius: 10)
                    .scaleEffect(doubleTapScale)
                    .opacity(doubleTapScale > 0 ? 1 : 0)
            }
            .contentShape(Rectangle())
            .onTapGesture(count: 2) {
                if !item.likedByMe {
                    onLike()
                }
                withAnimation(.spring(response: 0.3, dampingFraction: 0.6)) {
                    doubleTapScale = 1.2
                }
                withAnimation(.easeOut(duration: 0.3).delay(0.4)) {
                    doubleTapScale = 0
                }
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

                Button(action: onHide) {
                    Image(systemName: "eye.slash")
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
        .background(Color(.systemBackground))
        .task {
            await imageLoader.load()
        }
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
            let data = try await APIClient.shared.downloadData("/photos/file/\(filename)?w=1280")
            guard let loaded = UIImage(data: data) else { return }
            image = loaded
            await ImageCache.shared.store(loaded, forKey: cacheKey)
        } catch {
            // Silently fail
        }
    }
}
