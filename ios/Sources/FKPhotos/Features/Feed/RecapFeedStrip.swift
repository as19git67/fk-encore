import SwiftUI

/// Horizontal strip of unseen recaps at the top of the feed. Hidden when
/// everything has been seen (or the fetch fails) — the feed must never
/// depend on it. Tapping a card opens the story-style player directly.
struct RecapFeedStripView: View {
    @State private var viewModel = RecapsViewModel()
    @State private var playerItem: RecapPlayerItem?

    private let maxCards = 10

    private var unseen: [RecapSummary] {
        Array(viewModel.recaps.filter { viewModel.isUnseen($0) }.prefix(maxCards))
    }

    var body: some View {
        Group {
            if !unseen.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("Neue Rückblicke")
                            .font(.headline)
                        Spacer()
                        NavigationLink {
                            RecapsListView()
                        } label: {
                            Text("Alle")
                                .font(.subheadline)
                        }
                    }
                    .padding(.horizontal, 12)

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            ForEach(unseen) { recap in
                                Button {
                                    playerItem = RecapPlayerItem(id: recap.id)
                                } label: {
                                    RecapStripCard(
                                        recap: recap,
                                        coverFilename: viewModel.coverFilename(for: recap)
                                    )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 12)
                    }
                }
                .padding(.vertical, 8)
            }
        }
        .task {
            if viewModel.recaps.isEmpty { await viewModel.load() }
        }
        .fullScreenCover(item: $playerItem) { item in
            RecapPlayerView(
                recapId: item.id,
                onSeen: { id in Task { await viewModel.markSeen(id) } }
            )
        }
    }
}

/// One poster-style card in the strip: cover, play glyph, title + subtitle.
private struct RecapStripCard: View {
    let recap: RecapSummary
    let coverFilename: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .bottomTrailing) {
                cover
                    .frame(width: 140, height: 180)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                Image(systemName: "play.fill")
                    .font(.caption)
                    .foregroundStyle(.white)
                    .padding(8)
                    .background(.black.opacity(0.6), in: Circle())
                    .padding(8)
            }
            Text(recap.title)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
            if let subtitle = recap.subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .frame(width: 140, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityLabel("Rückblick „\(recap.title)“ abspielen")
    }

    @ViewBuilder
    private var cover: some View {
        if let coverFilename {
            PhotoThumbnailView(filename: coverFilename)
        } else {
            RoundedRectangle(cornerRadius: 12)
                .fill(Color.accentColor.opacity(0.15))
                .overlay {
                    Image(systemName: recap.recapKind.systemImage)
                        .foregroundStyle(.secondary)
                }
        }
    }
}
