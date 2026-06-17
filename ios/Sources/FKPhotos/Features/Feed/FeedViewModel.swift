import Foundation
import SwiftUI

@Observable
final class FeedViewModel {
    var items: [FeedPhotoItem] = []
    var isLoading = false
    var isLoadingMore = false
    var hasMore = true
    var unreadCount = 0
    var hiddenPhotoIds: Set<Int> = []
    var errorMessage: String?

    private var nextCursor: PhotoFeedCursor?
    private let pageSize = 12
    private let prefetchThreshold = 3
    private var newestSeenFeedItemId: Int?

    @MainActor
    func loadInitial() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            let query: [String: String] = ["limit": "\(pageSize)"]
            let response: ListPhotoFeedResponse = try await APIClient.shared.get(
                "/feed/photos", query: query
            )
            items = response.items
            nextCursor = response.nextCursor
            hasMore = response.nextCursor != nil

            await markDisplayedFeedSeen()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    func loadMore() async {
        guard !isLoadingMore, hasMore, let cursor = nextCursor else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }

        do {
            let query: [String: String] = [
                "cursorTs": cursor.ts,
                "cursorId": "\(cursor.id)",
                "limit": "\(pageSize)",
            ]
            let response: ListPhotoFeedResponse = try await APIClient.shared.get(
                "/feed/photos", query: query
            )
            items.append(contentsOf: response.items)
            nextCursor = response.nextCursor
            hasMore = response.nextCursor != nil
        } catch {
            // Silently fail on pagination errors
        }
    }

    @MainActor
    func loadMoreIfNeeded(visibleIndex index: Int) async {
        guard hasMore, !isLoadingMore, !isLoading else { return }
        guard index >= max(0, items.count - prefetchThreshold) else { return }
        await loadMore()
    }

    @MainActor
    func refreshUnreadCount() async {
        do {
            let response: UnreadCountResponse = try await APIClient.shared.get("/feed/unread-count")
            unreadCount = response.count
        } catch {
            // Badge count is best-effort
        }
    }

    @MainActor
    private func markDisplayedFeedSeen() async {
        guard !items.isEmpty else { return }
        do {
            let response: ListActivityFeedResponse = try await APIClient.shared.get(
                "/feed",
                query: ["limit": "1"]
            )
            guard let newestId = response.items.first?.id else {
                unreadCount = 0
                return
            }
            guard newestSeenFeedItemId != newestId || response.unreadCount > 0 else {
                unreadCount = 0
                return
            }
            let _: MarkSeenResponse = try await APIClient.shared.post(
                "/feed/mark-seen",
                body: MarkSeenRequest(upToId: newestId)
            )
            newestSeenFeedItemId = newestId
            unreadCount = 0
        } catch {
            await refreshUnreadCount()
        }
    }

    @MainActor
    func toggleLike(photoId: Int) async {
        guard let index = items.firstIndex(where: { $0.photoId == photoId }) else { return }
        let item = items[index]
        let newStatus = item.likedByMe ? "visible" : "favorite"
        let newCount = item.likedByMe ? max(0, item.likeCount - 1) : item.likeCount + 1
        let newLiked = !item.likedByMe

        // Optimistic update
        items[index] = FeedPhotoItem(
            photoId: item.photoId, filename: item.filename,
            width: item.width, height: item.height,
            description: item.description, takenAt: item.takenAt,
            lastActivityAt: item.lastActivityAt, album: item.album,
            owner: item.owner, likeCount: newCount, likedByMe: newLiked,
            commentCount: item.commentCount, latestComment: item.latestComment
        )

        do {
            let _: CurationResponse = try await APIClient.shared.patch(
                "/photos/\(photoId)/curation",
                body: CurationRequest(status: newStatus)
            )
        } catch {
            // Revert on error
            items[index] = item
        }
    }

    @MainActor
    func toggleHide(photoId: Int) async {
        let wasHidden = hiddenPhotoIds.contains(photoId)
        let newStatus = wasHidden ? "visible" : "hidden"

        withAnimation(.easeInOut(duration: 0.3)) {
            if wasHidden {
                hiddenPhotoIds.remove(photoId)
            } else {
                hiddenPhotoIds.insert(photoId)
            }
        }

        do {
            let _: CurationResponse = try await APIClient.shared.patch(
                "/photos/\(photoId)/curation",
                body: CurationRequest(status: newStatus)
            )
        } catch {
            withAnimation {
                if wasHidden {
                    hiddenPhotoIds.insert(photoId)
                } else {
                    hiddenPhotoIds.remove(photoId)
                }
            }
        }
    }
}
