import XCTest
@testable import FKPhotosLib

/// Scoping the near-duplicate groups to one album — the client-side trim that
/// lets the group review work inside an album without a server change.
final class AlbumGroupReviewTests: XCTestCase {

    private func group(
        id: Int,
        photoIds: [Int],
        cover: Int? = nil,
        picked: [Int]? = nil
    ) -> AlbumGroupReview.Group {
        AlbumGroupReview.Group(
            id: id,
            cover_photo_id: cover,
            member_count: photoIds.count,
            photo_ids: photoIds,
            reviewed_at: nil,
            ai_picked_photo_ids: picked,
            ai_picked_confidence: nil
        )
    }

    private func photo(
        id: Int,
        curation: CurationStatus = .visible,
        quality: Double? = nil
    ) -> PhotoWithCuration {
        PhotoWithCuration(
            id: id,
            user_id: 1,
            filename: "photo-\(id).jpg",
            original_name: "photo-\(id).jpg",
            mime_type: "image/jpeg",
            size: 1000,
            hash: nil,
            taken_at: nil,
            created_at: "2024-01-01T00:00:00.000Z",
            latitude: nil,
            longitude: nil,
            location_name: nil,
            location_city: nil,
            location_country: nil,
            ai_quality_score: quality,
            ai_quality_details: nil,
            auto_crop: nil,
            curation_status: curation,
            description: nil,
            keywords: nil
        )
    }

    func testAGroupIsTrimmedToTheAlbumsOwnPhotos() {
        let scoped = AlbumGroupReview.scoped(
            groups: [group(id: 7, photoIds: [1, 2, 99])],
            toVisiblePhotoIds: [1, 2]
        )
        XCTAssertEqual(scoped.first?.photo_ids, [1, 2])
        XCTAssertEqual(scoped.first?.member_count, 2)
    }

    /// One photo left is nothing to compare.
    func testAGroupWithOneMemberInTheAlbumIsDropped() {
        let scoped = AlbumGroupReview.scoped(
            groups: [group(id: 7, photoIds: [1, 99])],
            toVisiblePhotoIds: [1]
        )
        XCTAssertTrue(scoped.isEmpty)
    }

    func testACoverOutsideTheAlbumIsReplacedByOneInside() {
        let scoped = AlbumGroupReview.scoped(
            groups: [group(id: 7, photoIds: [1, 2, 99], cover: 99)],
            toVisiblePhotoIds: [1, 2]
        )
        XCTAssertEqual(scoped.first?.cover_photo_id, 1)
    }

    func testTheBiggestGroupIsOfferedFirst() {
        let scoped = AlbumGroupReview.scoped(
            groups: [
                group(id: 1, photoIds: [1, 2]),
                group(id: 2, photoIds: [3, 4, 5])
            ],
            toVisiblePhotoIds: [1, 2, 3, 4, 5]
        )
        XCTAssertEqual(scoped.map(\.id), [2, 1])
    }

    /// A photo already hidden is settled; it cannot pull a group back into the
    /// list, and a vote cast in this session counts the same as a stored one.
    func testHiddenPhotosDoNotCountTowardsAGroup() {
        let photos = [photo(id: 1), photo(id: 2, curation: .hidden), photo(id: 3)]
        let visible = AlbumGroupReview.visibleIds(in: photos, overrides: [3: .hidden])
        XCTAssertEqual(visible, [1])
    }

    func testTheComparisonGetsTheGroupsPhotosInOrderWithTheAiPickMarked() {
        let photos = [photo(id: 1, quality: 0.4), photo(id: 2, quality: 0.9)]
        let comparable = AlbumGroupReview.comparablePhotos(
            for: group(id: 7, photoIds: [1, 2], picked: [2]),
            from: photos
        )
        XCTAssertEqual(comparable.map(\.id), [1, 2])
        XCTAssertEqual(comparable.map(\.ai_picked), [false, true])
        XCTAssertEqual(comparable.last?.ai_quality_score, 0.9)
    }

    /// A group member the album never loaded is skipped rather than faked.
    func testAMemberWithoutAPhotoIsLeftOut() {
        let comparable = AlbumGroupReview.comparablePhotos(
            for: group(id: 7, photoIds: [1, 42], picked: nil),
            from: [photo(id: 1)]
        )
        XCTAssertEqual(comparable.map(\.id), [1])
    }
}
