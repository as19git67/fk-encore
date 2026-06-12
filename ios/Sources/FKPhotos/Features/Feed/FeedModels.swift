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
