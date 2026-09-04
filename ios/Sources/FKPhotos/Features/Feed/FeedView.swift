import SwiftUI

struct FeedView: View {
    let viewModel: FeedViewModel

    /// The open-group count, shown as a badge on the toolbar icon and as a
    /// banner above the stream (#968).
    @State private var reviewCount = ReviewQueueCount.shared
    /// Dismissing the banner silences it for this appearance only. A tile that
    /// stayed gone would take the count with it; the badge is the permanent
    /// reminder and this is the loud one.
    @State private var bannerDismissed = false
    @State private var openReview = false

    private var pendingGroups: Int {
        reviewCount.pending ?? 0
    }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 1) {
                if pendingGroups > 0, !bannerDismissed {
                    ReviewQueueBanner(
                        count: pendingGroups,
                        onOpen: { openReview = true },
                        onDismiss: { withAnimation { bannerDismissed = true } }
                    )
                }

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
                        // Reserves the badge's corner *inside* this label's
                        // reported bounds — see ReviewCountBadge's doc for
                        // why that has to be padding, not the overlay's own
                        // offset, under iOS 26's Liquid Glass toolbar.
                        .padding(.top, 5)
                        .padding(.trailing, 5)
                        .overlay(alignment: .topTrailing) {
                            ReviewCountBadge(count: reviewCount.pending)
                        }
                }
                .accessibilityLabel(
                    pendingGroups > 0
                        ? "Gruppen-Review, \(pendingGroups) offen"
                        : "Gruppen-Review"
                )
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
        .task {
            await reviewCount.refresh()
        }
        .navigationDestination(isPresented: $openReview) {
            ReviewQueueView()
        }
    }
}