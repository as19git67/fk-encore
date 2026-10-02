import Foundation

struct FeedPhotoItem: Codable, Identifiable, Sendable {
    var id: Int { photoId }

    let photoId: Int
    let filename: String
    let width: Int?
    let height: Int?
    let description: String?
    let takenAt: String?
    let lastActivityAt: String
    let album: FeedAlbumRef?
    let owner: FeedOwnerRef
    let likeCount: Int
    let likedByMe: Bool
    let commentCount: Int
    let latestComment: FeedCommentPreview?
    /// The other side of the viewer's format group, when this photo is one
    /// side of one (.claude/plans/orientierungs-varianten.md). The card shows
    /// whichever side fits the screen.
    var counterpart: OrientationCounterpart? = nil

    /// Portrait, landscape or square from the stored dimensions.
    var orientation: PhotoOrientation? {
        guard let width, let height, width > 0, height > 0 else { return nil }
        let ratio = Double(width) / Double(height)
        if ratio > 1.1 { return .landscape }
        if ratio < 0.9 { return .portrait }
        return .square
    }

    /// The file the card shows on this screen: the counterpart where it fits
    /// and the photo does not, else the photo's own.
    func shownFilename(for screen: ScreenOrientation) -> String {
        guard let counterpart else { return filename }
        let shown = SlideshowVariants.pickSide(
            (filename, orientation),
            counterpart: (counterpart.filename, counterpart.orientation),
            screen: screen,
            orientation: { $0.1 }
        )
        return shown.0
    }
}

struct FeedAlbumRef: Codable, Sendable {
    let id: Int
    let name: String
}

struct FeedOwnerRef: Codable, Sendable {
    let id: Int?
    let name: String?
}

struct FeedCommentPreview: Codable, Sendable {
    let author: String?
    let excerpt: String
}

struct PhotoFeedCursor: Codable, Sendable {
    let ts: String
    let id: Int
}

struct ListPhotoFeedResponse: Codable, Sendable {
    let items: [FeedPhotoItem]
    let nextCursor: PhotoFeedCursor?
}

struct ActivityFeedItemSummary: Codable, Sendable {
    let id: Int
}

struct ListActivityFeedResponse: Codable, Sendable {
    let items: [ActivityFeedItemSummary]
    let nextCursor: Int?
    let unreadCount: Int
}

struct UnreadCountResponse: Codable, Sendable {
    let count: Int
}

struct MarkSeenRequest: Encodable, Sendable {
    let upToId: Int
}

struct MarkSeenResponse: Codable, Sendable {
    let updated: Int
}

struct CurationRequest: Encodable, Sendable {
    let status: String
}

struct CurationResponse: Codable, Sendable {
    let success: Bool
}

struct PhotoComment: Codable, Identifiable, Sendable {
    let id: Int
    let photoId: Int
    let albumId: Int
    let author: CommentAuthor
    let body: String
    let createdAt: String
    let editedAt: String?
}

struct CommentAuthor: Codable, Sendable {
    let id: Int
    let name: String?
    let kind: String?
}

struct ListCommentsResponse: Codable, Sendable {
    let comments: [PhotoComment]
    let nextCursor: Int?
}

struct CreateCommentRequest: Encodable, Sendable {
    let body: String
    let albumId: Int
}
