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
    /// Deep-link pushes waiting at this root (#768 §5a).
    @State private var router = AppDeepLinkRouter.shared

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

                ForEach(viewModel.entries) { entry in
                    switch entry {
                    case .photo(let item):
                        FeedCardView(
                            item: item,
                            isHiddenByMe: viewModel.hiddenPhotoIds.contains(item.photoId),
                            onLike: { Task { await viewModel.toggleLike(photoId: item.photoId) } },
                            onToggleHide: { Task { await viewModel.toggleHide(photoId: item.photoId) } }
                        )
                    case .album(let album):
                        FeedAlbumCardView(album: album)
                    }

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
                NavigationLink(value: RecapsRef()) {
                    Image(systemName: "sparkles")
                }
                .accessibilityLabel("Rückblicke")
            }
            ToolbarItem(placement: .topBarTrailing) {
                // The KI-Assistent (documentation/plans/assistent-ios.md).
                AssistantEntryButton()
            }
        }
        .navigationDestination(for: RecapsRef.self) { _ in
            RecapsListView()
        }
        .navigationDestination(for: AssistantRef.self) { _ in
            AssistantScreen()
        }
        .assistantDestinations()
        // The push for a finished answer opens its conversation (stage 6).
        .navigationDestination(item: $router.assistantToOpen) { target in
            AssistantScreen(conversationId: target.conversationId)
        }
        // A shared album's card opens the album.
        .navigationDestination(for: FeedAlbumOpen.self) { ref in
            AlbumDetailView(albumId: ref.id)
        }
        // A deep link to the recaps (#768 §5a) pushes the same list from
        // here; item destination, not a path binding — see `AppDeepLinkRouter`.
        .navigationDestination(item: $router.recapsToOpen) { _ in
            RecapsListView()
        }
        .refreshable {
            await viewModel.loadInitial()
        }
        .overlay {
            if viewModel.isLoading && viewModel.entries.isEmpty {
                ProgressView("Lade Feed…")
            } else if viewModel.entries.isEmpty && !viewModel.isLoading {
                ContentUnavailableView {
                    Label("Kein Feed", systemImage: "house")
                } description: {
                    Text("Es gibt noch keine Aktivität in geteilten Alben.")
                }
            }
        }
        .task {
            if viewModel.entries.isEmpty {
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