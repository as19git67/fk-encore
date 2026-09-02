import XCTest
@testable import FKPhotosLib

/// Setting an album's cover photo: what the menu offers, and what goes on the
/// wire.
final class AlbumCoverTests: XCTestCase {

    private let inAlbum = [1, 2, 3]

    // MARK: - What is offered

    func testAPhotoInTheAlbumCanBecomeTheCover() {
        XCTAssertTrue(AlbumCover.canSetCover(
            photoId: 2, currentCoverId: nil, albumPhotoIds: inAlbum
        ))
    }

    func testTheCurrentCoverIsNotOfferedAgain() {
        // "Als Cover festlegen" on the cover does nothing worth a menu entry.
        XCTAssertFalse(AlbumCover.canSetCover(
            photoId: 2, currentCoverId: 2, albumPhotoIds: inAlbum
        ))
    }

    func testAPhotoOutsideTheAlbumCannotBecomeItsCover() {
        // The server rejects it outright; better not to offer it.
        XCTAssertFalse(AlbumCover.canSetCover(
            photoId: 99, currentCoverId: nil, albumPhotoIds: inAlbum
        ))
    }

    func testAnEmptyAlbumOffersNoCover() {
        XCTAssertFalse(AlbumCover.canSetCover(
            photoId: 1, currentCoverId: nil, albumPhotoIds: [Int]()
        ))
    }

    func testOnlyAnAlbumWithACoverCanClearOne() {
        XCTAssertTrue(AlbumCover.canClearCover(currentCoverId: 2))
        XCTAssertFalse(AlbumCover.canClearCover(currentCoverId: nil))
    }

    func testTheCoverKnowsItself() {
        XCTAssertTrue(AlbumCover.isCover(photoId: 2, currentCoverId: 2))
        XCTAssertFalse(AlbumCover.isCover(photoId: 3, currentCoverId: 2))
        XCTAssertFalse(AlbumCover.isCover(photoId: 3, currentCoverId: nil))
    }

    // MARK: - The request

    func testARefusedCoverProducesNoRequest() {
        XCTAssertNil(AlbumCover.request(
            albumId: 7, photoId: 99, currentCoverId: nil, albumPhotoIds: inAlbum
        ))
        XCTAssertNil(AlbumCover.request(
            albumId: 7, photoId: 2, currentCoverId: 2, albumPhotoIds: inAlbum
        ))
    }

    func testClearingNothingProducesNoRequest() {
        XCTAssertNil(AlbumCover.clearRequest(albumId: 7, currentCoverId: nil))
    }

    func testTheRequestNamesTheAlbumAndThePhoto() throws {
        let request = try XCTUnwrap(AlbumCover.request(
            albumId: 7, photoId: 3, currentCoverId: 1, albumPhotoIds: inAlbum
        ))
        let json = try encoded(request)
        XCTAssertEqual(json["id"] as? Int, 7)
        XCTAssertEqual(json["coverPhotoId"] as? Int, 3)
    }

    func testClearingSendsAnExplicitNull() throws {
        // A dropped key is how this endpoint spells "leave it alone", so a
        // cleared cover has to travel as a null or nothing happens.
        let request = try XCTUnwrap(AlbumCover.clearRequest(albumId: 7, currentCoverId: 2))
        let json = try encoded(request)
        XCTAssertTrue(json.keys.contains("coverPhotoId"))
        XCTAssertTrue(json["coverPhotoId"] is NSNull)
    }

    func testNothingElseIsSent() throws {
        // Only the cover: a name or description someone else edited in the
        // meantime must not be overwritten by this.
        let request = try XCTUnwrap(AlbumCover.request(
            albumId: 7, photoId: 3, currentCoverId: nil, albumPhotoIds: inAlbum
        ))
        XCTAssertEqual(Set(try encoded(request).keys), ["id", "coverPhotoId"])
    }

    private func encoded(_ request: AlbumCover.Request) throws -> [String: Any] {
        let data = try JSONEncoder().encode(request)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: - The response

    func testTheServersAnswerCarriesTheNewCover() throws {
        let json = """
        {"id": 7, "cover_photo_id": 3, "cover_filename": "photo-3.jpg"}
        """
        let response = try JSONDecoder().decode(
            AlbumCover.Response.self, from: Data(json.utf8)
        )
        XCTAssertEqual(response.cover_photo_id, 3)
        XCTAssertEqual(response.cover_filename, "photo-3.jpg")
    }

    func testAClearedCoverComesBackAsNothing() throws {
        let json = """
        {"id": 7, "cover_photo_id": null, "cover_filename": null}
        """
        let response = try JSONDecoder().decode(
            AlbumCover.Response.self, from: Data(json.utf8)
        )
        XCTAssertNil(response.cover_photo_id)
        XCTAssertNil(response.cover_filename)
    }
}
