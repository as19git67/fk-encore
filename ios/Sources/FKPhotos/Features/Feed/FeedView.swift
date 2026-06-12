import SwiftUI

struct FeedView: View {
    @State private var viewModel = FeedViewModel()

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 1) {
                ForEach(viewModel.items) { item in
                    FeedCardView(
                        item: item,
                        onLike: { Task { await viewModel.toggleLike(photoId: item.photoId) } },
                        onHide: { Task { await viewModel.hidePhoto(photoId: item.photoId) } }
                    )

                    Divider()
                        .padding(.vertical, 4)
                }

                if viewModel.isLoadingMore {
                    ProgressView()
                        .padding()
                }

                // Sentinel for infinite scroll
                Color.clear
                    .frame(height: 1)
                    .onAppear {
                        Task { await viewModel.loadMore() }
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
