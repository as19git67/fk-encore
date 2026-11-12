import CryptoKit
import SwiftUI

/// A place's picture, as the card and the sheets draw it (candidate
/// ranking, stage 2).
///
/// Loaded straight from Wikimedia, like the article's pictures (§25.4).
/// While it loads, or when it cannot, the frame keeps its size and shows
/// a quiet symbol: a row that jumps when the picture arrives is a row
/// somebody just tapped the wrong thing in.
struct TripSpotThumbnail: View {
    let image: TripRoutePhoto
    var height: CGFloat
    var width: CGFloat? = nil
    /// Whether a grey box stands in while the picture loads and when it
    /// does not come. Off where the picture is a garnish (the cards of
    /// a day): there nothing is better than a box with nothing in it.
    var placeholder: Bool = true
    @State private var failed = false
    @State private var loaded: UIImage?

    var body: some View {
        if !placeholder && failed {
            EmptyView()
        } else {
            framed
        }
    }

    private var framed: some View {
        // The frame is a plain rectangle and the picture an overlay on
        // it: a filled picture is wider than its frame, and laid out
        // itself it pushed the text beside it out of place.
        Rectangle()
            .fill(placeholder ? AnyShapeStyle(.quaternary) : AnyShapeStyle(.clear))
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil)
            .overlay {
                if let loaded {
                    Image(uiImage: loaded).resizable().scaledToFill()
                } else if failed {
                    Image(systemName: "photo").foregroundStyle(.secondary)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: width == nil ? 0 : 8))
            .contentShape(RoundedRectangle(cornerRadius: width == nil ? 0 : 8))
            .task(id: image.thumbUrl) { await load() }
    }

    /// From the app's image cache, else fetched and decoded off the main
    /// thread: `AsyncImage` kept nothing, so every row scrolled back into
    /// view fetched and decoded its picture again, and the list stuttered
    /// (Anton, 11.11.).
    private func load() async {
        let key = TripThumbnailCache.key(image.thumbUrl)
        if let hit = await ImageCache.shared.image(forKey: key) {
            loaded = hit
            return
        }
        guard let url = URL(string: image.thumbUrl) else {
            failed = true
            return
        }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            guard let raw = UIImage(data: data) else {
                failed = true
                return
            }
            let prepared = await raw.byPreparingForDisplay() ?? raw
            await ImageCache.shared.store(prepared, forKey: key)
            guard !Task.isCancelled else { return }
            loaded = prepared
        } catch {
            if !Task.isCancelled { failed = true }
        }
    }
}

/// Keys of the spot pictures in the app's image cache: a hash, since a
/// Commons address is longer than a file name may be.
enum TripThumbnailCache {
    static func key(_ url: String) -> String {
        "trip-thumb-" + SHA256.hash(data: Data(url.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// The pictures at the top of a spot's details (mock "Ablauf 2", step
/// 3): the place's own picture large, the gallery's others smaller
/// beside it two by two, swiped sideways when there are more than fit.
/// Every picture opens its page on Commons, where its licence is.
struct TripSpotGallery: View {
    /// The place's own first, as the server orders the gallery.
    let photos: [TripRoutePhoto]

    private let height: CGFloat = 172
    private let gap: CGFloat = 6

    var body: some View {
        if let first = photos.first {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: gap) {
                            picture(first, width: height * 4 / 3, height: height)
                            ForEach(Array(stride(from: 1, to: photos.count, by: 2)), id: \.self) { index in
                                VStack(spacing: gap) {
                                    small(photos[index])
                                    if index + 1 < photos.count {
                                        small(photos[index + 1])
                                    } else {
                                        Color.clear.frame(width: smallWidth, height: smallHeight)
                                    }
                                }
                            }
                        }
                        .padding(.horizontal, 16)
                    }
                    .frame(height: height)
                    Text(first.credit)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .padding(.horizontal, 16)
                }
                .padding(.vertical, 8)
                .listRowInsets(EdgeInsets())
            }
        }
    }

    private var smallHeight: CGFloat { (height - gap) / 2 }
    private var smallWidth: CGFloat { smallHeight * 4 / 3 }

    private func small(_ photo: TripRoutePhoto) -> some View {
        picture(photo, width: smallWidth, height: smallHeight)
    }

    private func picture(_ photo: TripRoutePhoto, width: CGFloat, height: CGFloat) -> some View {
        Link(destination: URL(string: photo.pageUrl) ?? URL(string: "https://commons.wikimedia.org")!) {
            TripSpotThumbnail(image: photo, height: height, width: width)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Bild auf Wikimedia Commons öffnen")
    }

    /// The gallery of a place, its own picture first; just that picture
    /// when the gallery does not answer.
    static func load(osmRef: String, image: TripRoutePhoto?) async -> [TripRoutePhoto] {
        do {
            let response: TripRoutePhotosResponse = try await APIClient.shared.get(
                "/trip-planner/spots/gallery",
                query: ["osmRef": osmRef],
            )
            let rest = response.photos.filter { $0.pageUrl != image?.pageUrl }
            return (image.map { [$0] } ?? []) + rest
        } catch {
            return image.map { [$0] } ?? []
        }
    }
}
