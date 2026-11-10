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
                AsyncImage(url: URL(string: image.thumbUrl)) { phase in
                    switch phase {
                    case .success(let picture):
                        picture.resizable().scaledToFill()
                    case .failure:
                        if placeholder {
                            Image(systemName: "photo").foregroundStyle(.secondary)
                        } else {
                            Color.clear.onAppear { failed = true }
                        }
                    default:
                        Color.clear
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: width == nil ? 0 : 8))
            .contentShape(RoundedRectangle(cornerRadius: width == nil ? 0 : 8))
    }
}

/// The place's own picture, large, and under it a strip of what its
/// Commons category holds (candidate ranking, stage 2).
///
/// Wikipedia articles use one or two photographs; the category of the
/// same place often has dozens, taken from every side. The strip loads
/// when the screen opens and is simply absent when there is nothing
/// more — or when Commons does not answer, which is not an error over a
/// place that is otherwise all there.
struct TripSpotPictures: View {
    let osmRef: String
    let image: TripRoutePhoto?

    @State private var more: [TripRoutePhoto] = []
    @State private var loaded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let image {
                Link(destination: URL(string: image.pageUrl) ?? URL(string: "https://commons.wikimedia.org")!) {
                    TripSpotThumbnail(image: image, height: 220)
                }
                .accessibilityLabel("Bild des Orts auf Wikimedia Commons öffnen")
                Text(image.credit)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 16)
            }
            if !more.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: 8) {
                        ForEach(more) { photo in
                            Link(destination: URL(string: photo.pageUrl) ?? URL(string: "https://commons.wikimedia.org")!) {
                                VStack(alignment: .leading, spacing: 2) {
                                    TripSpotThumbnail(image: photo, height: 96, width: 128)
                                    Text(photo.credit)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                        .frame(width: 128, alignment: .leading)
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Weiteres Bild auf Wikimedia Commons öffnen")
                        }
                    }
                    .padding(.horizontal, 16)
                }
                .frame(height: 120)
            }
        }
        .padding(.bottom, 8)
        .task { await load() }
    }

    private func load() async {
        guard !loaded else { return }
        defer { loaded = true }
        do {
            let response: TripRoutePhotosResponse = try await APIClient.shared.get(
                "/trip-planner/spots/gallery",
                query: ["osmRef": osmRef],
            )
            // The large picture is already on screen.
            more = response.photos.filter { $0.pageUrl != image?.pageUrl }
        } catch {
            more = []
        }
    }
}
