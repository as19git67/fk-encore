import Foundation

/// Which photo an album shows as its cover.
///
/// `PATCH /albums` has always taken a `coverPhotoId`; the web sets it and iOS
/// never did, so an album picked its own cover (the newest photo) and there
/// was no way to say otherwise from the phone.
///
/// The server's one rule is that the cover **must be a photo in the album** —
/// it rejects anything else — so the same rule is checked here before a
/// request goes out, and it decides what the menu offers.
///
/// Pure: ids in, a decision out.
enum AlbumCover {

    /// Body for `PATCH /albums`.
    ///
    /// Only `id` and the cover are sent. The endpoint treats a missing field
    /// as „leave it alone", so a cover change cannot overwrite a name or a
    /// description someone else edited in the meantime.
    struct Request: Encodable, Sendable {
        let id: Int
        let coverPhotoId: Int?

        // Written by hand because the synthesized encoding drops a nil
        // (`encodeIfPresent`), and a dropped key is exactly how this endpoint
        // spells „leave it alone" — clearing the cover would silently do
        // nothing. The null has to be on the wire.
        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(id, forKey: .id)
            try container.encode(coverPhotoId, forKey: .coverPhotoId)
        }

        enum CodingKeys: String, CodingKey {
            case id, coverPhotoId
        }
    }

    /// What comes back. A minimal projection: the update response carries no
    /// `is_shared` or `my_access_level`, so decoding it as `Album` would fail.
    struct Response: Decodable, Sendable {
        let id: Int
        let cover_photo_id: Int?
        let cover_filename: String?
    }

    /// Whether this photo can be made the cover.
    ///
    /// False when it already is — „als Cover festlegen" on the current cover
    /// does nothing and should not be offered — and false when the photo is
    /// not in the album, which the server would reject anyway.
    static func canSetCover(
        photoId: Int,
        currentCoverId: Int?,
        albumPhotoIds: some Collection<Int>
    ) -> Bool {
        guard photoId != currentCoverId else { return false }
        return albumPhotoIds.contains(photoId)
    }

    /// Whether the album has a cover to clear.
    ///
    /// Clearing is a real choice rather than a no-op: without one the album
    /// falls back to its newest photo, which keeps moving as photos are added.
    static func canClearCover(currentCoverId: Int?) -> Bool {
        currentCoverId != nil
    }

    /// Whether a photo is the album's cover today.
    static func isCover(photoId: Int, currentCoverId: Int?) -> Bool {
        currentCoverId == photoId
    }

    /// The request for setting a cover, or nil when it would be refused.
    static func request(
        albumId: Int,
        photoId: Int,
        currentCoverId: Int?,
        albumPhotoIds: some Collection<Int>
    ) -> Request? {
        guard canSetCover(
            photoId: photoId, currentCoverId: currentCoverId, albumPhotoIds: albumPhotoIds
        ) else { return nil }
        return Request(id: albumId, coverPhotoId: photoId)
    }

    /// The request for going back to no cover, or nil when there is none set.
    static func clearRequest(albumId: Int, currentCoverId: Int?) -> Request? {
        guard canClearCover(currentCoverId: currentCoverId) else { return nil }
        return Request(id: albumId, coverPhotoId: nil)
    }
}
