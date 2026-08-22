import XCTest
@testable import FKPhotosLib

/// Decoding of `GET /photos/details`, the endpoint `PhotoFetch.byId` goes to.
///
/// The feed's double-tap-to-fullscreen was broken because the app asked for
/// `GET /photos/:id`, which the server does not have: the 404 was swallowed and
/// nothing opened. These pin the payload the batch endpoint actually returns
/// (`getPhotoDetailsBatchLogic` in `photo/photo.service.ts`) so a shape change
/// fails here instead of silently doing nothing on screen.
final class PhotoFetchTests: XCTestCase {

    /// Mirrors one row as the server emits it — including the two keys the iOS
    /// model does not carry (`location_short`, `ai_quality_details`), which
    /// must be ignored rather than fail the decode. Values are synthetic.
    private let fullRow = """
    {
      "photos": [
        {
          "id": 42,
          "user_id": 7,
          "filename": "abc123.jpg",
          "original_name": "IMG_0001.HEIC",
          "mime_type": "image/jpeg",
          "size": 2481920,
          "hash": "0000000000000000000000000000000000000000000000000000000000000000",
          "taken_at": "2026-01-14T10:30:00.000Z",
          "created_at": "2026-01-15T08:00:00.000Z",
          "curation_status": "favorite",
          "latitude": 48.1,
          "longitude": 11.5,
          "location_name": "Beispielplatz",
          "location_city": "Musterstadt",
          "location_country": "Deutschland",
          "location_short": "Musterstadt",
          "ai_quality_score": 0.75,
          "ai_quality_details": { "sharpness": 0.8 },
          "auto_crop": { "x": 0.4, "y": 0.3 },
          "description": "Am Beispielsee",
          "keywords": ["urlaub", "see"]
        }
      ]
    }
    """

    func testDecodesAFullRow() throws {
        let response = try JSONDecoder().decode(
            PhotoDetailsBatchResponse.self,
            from: Data(fullRow.utf8)
        )
        let photo = try XCTUnwrap(response.photos.first)
        XCTAssertEqual(photo.id, 42)
        XCTAssertEqual(photo.filename, "abc123.jpg")
        XCTAssertEqual(photo.curation_status, .favorite)
        XCTAssertEqual(photo.description, "Am Beispielsee")
        XCTAssertEqual(photo.keywords, ["urlaub", "see"])
        XCTAssertEqual(photo.auto_crop?.x ?? 0, 0.4, accuracy: 0.0001)
        XCTAssertEqual(photo.auto_crop?.y ?? 0, 0.3, accuracy: 0.0001)
    }

    /// The server omits every nullable column rather than sending null, and
    /// normalizes `created_at` / `curation_status` before sending — so the
    /// sparsest possible row still decodes.
    func testDecodesAMinimalRow() throws {
        let json = """
        {
          "photos": [
            {
              "id": 1,
              "user_id": 1,
              "filename": "x.jpg",
              "original_name": "x.jpg",
              "mime_type": "image/jpeg",
              "size": 100,
              "created_at": "2026-01-15T08:00:00.000Z",
              "curation_status": "visible",
              "keywords": []
            }
          ]
        }
        """
        let response = try JSONDecoder().decode(
            PhotoDetailsBatchResponse.self,
            from: Data(json.utf8)
        )
        let photo = try XCTUnwrap(response.photos.first)
        XCTAssertEqual(photo.curation_status, .visible)
        XCTAssertNil(photo.taken_at)
        XCTAssertNil(photo.auto_crop)
        XCTAssertNil(photo.description)
    }

    /// An unknown id — or one the caller may not see — comes back as an empty
    /// list, which is what `PhotoFetch.byId` turns into a 404.
    func testDecodesAnEmptyResult() throws {
        let response = try JSONDecoder().decode(
            PhotoDetailsBatchResponse.self,
            from: Data("{\"photos\":[]}".utf8)
        )
        XCTAssertTrue(response.photos.isEmpty)
    }
}
