import XCTest
@testable import FKPhotosLib

final class FKPhotosTests: XCTestCase {

    func testKeychainSaveAndLoad() throws {
        let key = "test_token"
        let value = "test_value_123"

        try KeychainHelper.saveString(value, forKey: key)
        let loaded = KeychainHelper.loadString(forKey: key)

        XCTAssertEqual(loaded, value)

        // Cleanup
        KeychainHelper.delete(forKey: key)
        XCTAssertNil(KeychainHelper.loadString(forKey: key))
    }

    func testKeychainDelete() throws {
        let key = "test_delete"
        try KeychainHelper.saveString("value", forKey: key)

        KeychainHelper.delete(forKey: key)

        XCTAssertNil(KeychainHelper.loadString(forKey: key))
    }

    func testModelDecoding() throws {
        let json = """
        {
            "id": 1,
            "user_id": 1,
            "filename": "abc123.jpg",
            "original_name": "photo.jpg",
            "mime_type": "image/jpeg",
            "size": 1024,
            "created_at": "2024-01-01T00:00:00Z",
            "curation_status": "visible"
        }
        """.data(using: .utf8)!

        let photo = try JSONDecoder().decode(PhotoWithCuration.self, from: json)

        XCTAssertEqual(photo.id, 1)
        XCTAssertEqual(photo.filename, "abc123.jpg")
        XCTAssertEqual(photo.curation_status, .visible)
    }

    func testAlbumDecoding() throws {
        let json = """
        {
            "id": 1,
            "user_id": 1,
            "name": "Urlaub 2024",
            "display_mode": "grid",
            "photo_count": 42,
            "is_shared": false,
            "created_at": "2024-01-01T00:00:00Z",
            "updated_at": "2024-01-01T00:00:00Z"
        }
        """.data(using: .utf8)!

        let album = try JSONDecoder().decode(Album.self, from: json)

        XCTAssertEqual(album.name, "Urlaub 2024")
        XCTAssertEqual(album.photo_count, 42)
        XCTAssertFalse(album.is_shared)
    }

    func testLoginRequestEncoding() throws {
        let request = LoginRequest(email: "test@example.com", password: "secret")
        let data = try JSONEncoder().encode(request)
        let decoded = try JSONDecoder().decode(LoginRequest.self, from: data)

        XCTAssertEqual(decoded.email, "test@example.com")
        XCTAssertEqual(decoded.password, "secret")
    }
}
