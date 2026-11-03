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
    /// side of one (documentation/plans/orientierungs-varianten.md). The card shows
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
    /// Albums shared with the viewer that fall into the same stretch of the
    /// timeline as `items` — one card each instead of every photo in them.
    /// Optional so an older server without the field still decodes.
    var albums: [FeedAlbumItem]? = nil
    let nextCursor: PhotoFeedCursor?
}

/// An album someone shared with the viewer, shown once in the feed as a card
/// that opens the album (`GET /feed/photos` → `albums`).
struct FeedAlbumItem: Codable, Identifiable, Sendable {
    var id: Int { albumId }

    let albumId: Int
    let name: String
    let description: String?
    let lastActivityAt: String
    let owner: FeedOwnerRef
    /// Who shared it with the viewer (the inviter, else the owner).
    let sharedBy: FeedOwnerRef
    let accessLevel: String
    let photoCount: Int
    /// Up to four photos: the cover first, then the newest added.
    let previews: [FeedAlbumPreview]
}

struct FeedAlbumPreview: Codable, Sendable {
    let photoId: Int
    let filename: String
    let width: Int?
    let height: Int?
}

/// Navigation value for opening a shared album from its feed card.
struct FeedAlbumOpen: Hashable, Sendable {
    let id: Int
}

/// One row of the feed: a photo or a shared album.
enum FeedEntry: Identifiable, Sendable {
    case photo(FeedPhotoItem)
    case album(FeedAlbumItem)

    var id: String {
        switch self {
        case .photo(let item): "p\(item.photoId)"
        case .album(let album): "a\(album.albumId)"
        }
    }
}

enum FeedStream {
    /// Photos in server order with the album cards slotted in by
    /// `lastActivityAt`, newest first; on a tie the photo stays first. The
    /// photo order is never changed — the server's keyset order is the truth.
    /// Same rule as `feedStream` in the web app (utils/photoFeedMerge.ts).
    static func entries(items: [FeedPhotoItem], albums: [FeedAlbumItem]) -> [FeedEntry] {
        let cards = albums.sorted {
            $0.lastActivityAt == $1.lastActivityAt
                ? $0.albumId > $1.albumId
                : $0.lastActivityAt > $1.lastActivityAt
        }
        var out: [FeedEntry] = []
        out.reserveCapacity(items.count + cards.count)
        var next = 0
        for item in items {
            while next < cards.count, cards[next].lastActivityAt > item.lastActivityAt {
                out.append(.album(cards[next]))
                next += 1
            }
            out.append(.photo(item))
        }
        while next < cards.count {
            out.append(.album(cards[next]))
            next += 1
        }
        return out
    }

    /// Add freshly fetched cards to the loaded ones; a card fetched again
    /// replaces its older copy.
    static func mergeAlbums(_ current: [FeedAlbumItem], _ incoming: [FeedAlbumItem]) -> [FeedAlbumItem] {
        var result = current
        for album in incoming {
            if let index = result.firstIndex(where: { $0.albumId == album.albumId }) {
                result[index] = album
            } else {
                result.append(album)
            }
        }
        return result
    }
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
