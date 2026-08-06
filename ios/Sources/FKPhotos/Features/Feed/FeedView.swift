import SwiftUI

struct FeedView: View {
    let viewModel: FeedViewModel

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 1) {
                RecapFeedStripView()

                ForEach(viewModel.items) { item in
                    FeedCardView(
                        item: item,
                        isHiddenByMe: viewModel.hiddenPhotoIds.contains(item.photoId),
                        onLike: { Task { await viewModel.toggleLike(photoId: item.photoId) } },
                        onToggleHide: { Task { await viewModel.toggleHide(photoId: item.photoId) } }
                    )

                    Divider()
                        .padding(.vertical, 4)
                }

                if viewModel.hasMore {
                    Color.clear
                        .frame(height: 80)
                        .onAppear {
                            Task { await viewModel.loadMore() }
                        }
                }

                if viewModel.isLoadingMore {
                    ProgressView()
                        .padding()
                }
            }
        }
        .navigationTitle("Feed")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink {
                    ReviewQueueView()
                } label: {
                    Image(systemName: "checklist")
                }
                .accessibilityLabel("Gruppen-Review")
            }
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink {
                    RecapsListView()
                } label: {
                    Image(systemName: "sparkles")
                }
                .accessibilityLabel("Rückblicke")
            }
        }
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