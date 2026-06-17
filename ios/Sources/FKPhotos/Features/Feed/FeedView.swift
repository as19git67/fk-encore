import SwiftUI

struct FeedView: View {
    let viewModel: FeedViewModel

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 1) {
                ForEach(Array(viewModel.items.enumerated()), id: \.element.id) { index, item in
                    FeedCardView(
                        item: item,
                        isHiddenByMe: viewModel.hiddenPhotoIds.contains(item.photoId),
                        onLike: { Task { await viewModel.toggleLike(photoId: item.photoId) } },
                        onToggleHide: { Task { await viewModel.toggleHide(photoId: item.photoId) } }
                    )
                    .onAppear {
                        Task { await viewModel.loadMoreIfNeeded(visibleIndex: index) }
                    }

                    Divider()
                        .padding(.vertical, 4)
                }

                if viewModel.isLoadingMore {
                    ProgressView()
                        .padding()
                }
            }
        }
        .navigationTitle("Feed")
        .refreshable {
            await viewModel.loadInitial()
        }
        .overlay {
            if viewModel.isLoading && viewModel.items.isEmpty {
                ProgressView("Lade Feed…")
            } else if viewModel.items.isEmpty && !viewModel.isLoading {
                ContentUnavailableView {
                    Label("Kein Feed", systemImage: "house")
                } description: {
                    Text("Es gibt noch keine Aktivität in deinen Alben.")
                }
            }
        }
        .task {
            if viewModel.items.isEmpty {
                await viewModel.loadInitial()
            }
        }
    }
}
