import XCTest
@testable import FKPhotosLib

/// The feed slots shared-album cards into the photo stream by time — the same
/// rule as `feedStream` in the web app (frontend/src/utils/photoFeedMerge.ts).
final class FeedStreamTests: XCTestCase {

    private func photo(_ id: Int, _ ts: String) -> FeedPhotoItem {
        FeedPhotoItem(
            photoId: id, filename: "img\(id).jpg", width: nil, height: nil, description: nil,
            takenAt: nil, lastActivityAt: ts, album: nil,
            owner: FeedOwnerRef(id: 1, name: "Beispiel"),
            likeCount: 0, likedByMe: false, commentCount: 0, latestComment: nil,
        )
    }

    private func card(_ id: Int, _ ts: String, name: String? = nil) -> FeedAlbumItem {
        FeedAlbumItem(
            albumId: id, name: name ?? "Album \(id)", description: nil, lastActivityAt: ts,
            owner: FeedOwnerRef(id: 1, name: "Beispiel"),
            sharedBy: FeedOwnerRef(id: 1, name: "Beispiel"),
            accessLevel: "read", photoCount: 3, previews: [],
        )
    }

    func testCardsSitBetweenPhotosByTime() {
        let entries = FeedStream.entries(
            items: [photo(3, "2026-07-03T10:00:00Z"), photo(1, "2026-07-01T10:00:00Z")],
            albums: [
                card(10, "2026-07-02T10:00:00Z"),
                card(11, "2026-07-09T10:00:00Z"),
                card(12, "2026-06-01T10:00:00Z"),
            ]
        )
        XCTAssertEqual(entries.map(\.id), ["a11", "p3", "a10", "p1", "a12"])
    }

    func testPhotoStaysFirstOnATie() {
        let entries = FeedStream.entries(
            items: [photo(3, "2026-07-03T10:00:00Z")],
            albums: [card(10, "2026-07-03T10:00:00Z")]
        )
        XCTAssertEqual(entries.map(\.id), ["p3", "a10"])
    }

    func testCardsAloneWithoutPhotos() {
        let entries = FeedStream.entries(items: [], albums: [card(10, "2026-07-03T10:00:00Z")])
        XCTAssertEqual(entries.map(\.id), ["a10"])
    }

    func testACardFetchedAgainReplacesItsOlderCopy() {
        let merged = FeedStream.mergeAlbums(
            [card(10, "2026-07-01T10:00:00Z"), card(11, "2026-07-02T10:00:00Z")],
            [card(10, "2026-07-05T10:00:00Z", name: "neu")]
        )
        XCTAssertEqual(merged.map(\.albumId), [10, 11])
        XCTAssertEqual(merged.first?.name, "neu")
    }

    func testResponseDecodesWithAndWithoutAlbums() throws {
        let without = Data(#"{"items":[],"nextCursor":null}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(ListPhotoFeedResponse.self, from: without).albums)

        let with = Data(#"""
        {"items":[],"nextCursor":null,"albums":[{
          "albumId":7,"name":"Sommerfest","description":null,
          "lastActivityAt":"2026-07-03T10:00:00.000Z",
          "owner":{"id":1,"name":"Beispiel"},"sharedBy":{"id":1,"name":"Beispiel"},
          "accessLevel":"read","photoCount":2,
          "previews":[{"photoId":5,"filename":"a.jpg","width":100,"height":80}]
        }]}
        """#.utf8)
        let decoded = try JSONDecoder().decode(ListPhotoFeedResponse.self, from: with)
        XCTAssertEqual(decoded.albums?.first?.albumId, 7)
        XCTAssertEqual(decoded.albums?.first?.previews.first?.filename, "a.jpg")
    }
}
