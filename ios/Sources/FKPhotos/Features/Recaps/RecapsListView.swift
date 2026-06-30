import SwiftUI

/// Lists the user's recaps ("Rückblicke") and opens the story-style player.
/// Reached from the Feed toolbar. Read-only — recaps are generated server-side.
struct RecapsListView: View {
    @State private var viewModel = RecapsViewModel()
    @State private var playerItem: RecapPlayerItem?

    var body: some View {
        List {
            if viewModel.isLoading && viewModel.recaps.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .listRowSeparator(.hidden)
            } else if viewModel.recaps.isEmpty {
                ContentUnavailableView {
                    Label("Keine Rückblicke", systemImage: "sparkles")
                } description: {
                    Text("Sobald genügend Fotos vorhanden sind, erstellt die App automatisch Rückblicke.")
                }
                .listRowSeparator(.hidden)
            } else {
                ForEach(viewModel.recaps) { recap in
                    Button {
                        playerItem = RecapPlayerItem(id: recap.id)
                    } label: {
                        RecapRow(
                            recap: recap,
                            isUnseen: viewModel.isUnseen(recap),
                            coverFilename: viewModel.coverFilename(for: recap)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle("Rückblicke")
        .refreshable { await viewModel.load() }
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

/// Identifiable wrapper so `fullScreenCover(item:)` can present the player.
struct RecapPlayerItem: Identifiable {
    let id: Int
}

private struct RecapRow: View {
    let recap: RecapSummary
    let isUnseen: Bool
    let coverFilename: String?

    var body: some View {
        HStack(spacing: 12) {
            cover
                .frame(width: 72, height: 72)
                .clipShape(RoundedRectangle(cornerRadius: 8))

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    if isUnseen {
                        Text("Neu")
                            .font(.caption2).bold()
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.accentColor, in: Capsule())
                            .foregroundStyle(.white)
                    }
                    Image(systemName: recap.recapKind.systemImage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text(recap.title)
                    .font(.headline)
                    .lineLimit(2)
                if let subtitle = recap.subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Text(recap.photo_count == 1 ? "1 Foto" : "\(recap.photo_count) Fotos")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var cover: some View {
        if let coverFilename {
            PhotoThumbnailView(filename: coverFilename)
        } else {
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.accentColor.opacity(0.15))
                .overlay {
                    Image(systemName: recap.recapKind.systemImage)
                        .foregroundStyle(.secondary)
                }
        }
    }
}
