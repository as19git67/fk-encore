import XCTest
@testable import FKPhotosLib

/// Pins the client side of the upload HTTP contract (issue #591): that
/// `APIClient.uploadPhoto` sends exactly the `X-*` headers, encodings and body
/// the server (`photo.ts` / `parseUploadHeaders`) reads, and that it maps each
/// status code to the right `UploadResult`.
///
/// The server side of the very same contract is covered by the TypeScript
/// `photo.test.ts` "iOS upload header contract (#591)" suite, which feeds these
/// exact header names/encodings into the real dedup/metadata pipeline. Together
/// the two suites meet in the middle: this proves the client *emits* the
/// contract, that one proves the server *honours* it.
final class UploadContractTests: XCTestCase {

    override func setUp() {
        super.setUp()
        MockURLProtocol.reset()
        // Keep the Authorization header out of the picture (deterministic).
        KeychainHelper.delete(forKey: "auth_token")
    }

    override func tearDown() {
        MockURLProtocol.reset()
        super.tearDown()
    }

    private func makeClient() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return APIClient(session: URLSession(configuration: config))
    }

    private func photoJSON(id: Int) -> Data {
        Data("""
        {"id":\(id),"user_id":1,"filename":"stored.heic","original_name":"IMG 1.heic",
         "mime_type":"image/heic","size":1234,"created_at":"2026-01-01T00:00:00Z"}
        """.utf8)
    }

    private func upload(
        _ client: APIClient,
        latitude: Double? = 48.137154,
        longitude: Double? = 11.576124
    ) async throws -> APIClient.UploadResult {
        try await client.uploadPhoto(
            data: Data("the-image-bytes".utf8),
            filename: "IMG 1.heic",
            mimeType: "image/heic",
            imageDataHash: "ab".repeated(32),
            fullHash: "cd".repeated(32),
            caption: "Föhr Strand",
            isFavorite: true,
            capturedAtString: "2026-05-20T15:00:00+02:00",
            assetLocalId: "DEV-1/L0/001",
            latitude: latitude,
            longitude: longitude
        )
    }

    // MARK: - Request contract

    func testUploadSendsExpectedHeadersAndBody() async throws {
        MockURLProtocol.stub = .init(status: 201, body: photoJSON(id: 101))

        let result = try await upload(makeClient())
        guard case .created(let photo) = result else {
            return XCTFail("expected .created, got \(result)")
        }
        XCTAssertEqual(photo.id, 101)

        let req = try XCTUnwrap(MockURLProtocol.capturedRequest)
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "image/heic")
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-Image-Data-Hash"), "ab".repeated(32))
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-Full-Hash"), "cd".repeated(32))
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-Is-Favorite"), "true")
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-Captured-At"), "2026-05-20T15:00:00+02:00")
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-Asset-Id"), "DEV-1/L0/001")

        // Percent-encoded exactly as the server's decodeURIComponent expects.
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-Description"), "F%C3%B6hr%20Strand")
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-File-Name"), "IMG%201.heic")

        // GPS forwarded as decimal strings the server parses with parseFloat.
        let lat = try XCTUnwrap(req.value(forHTTPHeaderField: "X-GPS-Lat").flatMap(Double.init))
        let lng = try XCTUnwrap(req.value(forHTTPHeaderField: "X-GPS-Lng").flatMap(Double.init))
        XCTAssertEqual(lat, 48.137154, accuracy: 1e-6)
        XCTAssertEqual(lng, 11.576124, accuracy: 1e-6)

        // The raw image bytes are sent verbatim (no re-encoding).
        XCTAssertEqual(MockURLProtocol.capturedBody, Data("the-image-bytes".utf8))
    }

    func testGpsHeadersOmittedWhenNoLocation() async throws {
        MockURLProtocol.stub = .init(status: 201, body: photoJSON(id: 102))
        _ = try await upload(makeClient(), latitude: nil, longitude: nil)

        let req = try XCTUnwrap(MockURLProtocol.capturedRequest)
        XCTAssertNil(req.value(forHTTPHeaderField: "X-GPS-Lat"))
        XCTAssertNil(req.value(forHTTPHeaderField: "X-GPS-Lng"))
    }

    // MARK: - Response branching

    func testMetadataUpdateMapsToUpdated() async throws {
        MockURLProtocol.stub = .init(status: 200, body: Data(#"{"updated":true,"photoId":7}"#.utf8))
        let result = try await upload(makeClient())
        guard case .updated(let id) = result else {
            return XCTFail("expected .updated, got \(result)")
        }
        XCTAssertEqual(id, 7)
    }

    func testDuplicateMapsToDuplicatePhotoError() async {
        MockURLProtocol.stub = .init(status: 409, body: Data(#"{"photoId":42}"#.utf8))
        do {
            _ = try await upload(makeClient())
            XCTFail("expected a thrown duplicatePhoto error")
        } catch let APIError.duplicatePhoto(existingId) {
            XCTAssertEqual(existingId, 42)
        } catch {
            XCTFail("expected APIError.duplicatePhoto, got \(error)")
        }
    }

    // MARK: - Metadata-only sync contract

    func testSyncMetadataNotFoundMapsToNotFound() async throws {
        MockURLProtocol.stub = .init(status: 404, body: Data(#"{"code":"not_found","message":"x"}"#.utf8))
        let result = try await makeClient().syncPhotoMetadata(
            imageDataHash: "ab".repeated(32),
            fullHash: "cd".repeated(32),
            caption: "x",
            isFavorite: false,
            capturedAtString: "2026-01-01T00:00:00Z",
            assetLocalId: "DEV-1/L0/001"
        )
        guard case .notFound = result else {
            return XCTFail("expected .notFound, got \(result)")
        }
    }
}

private extension String {
    /// Small readability helper for building 64-char hex test hashes.
    func repeated(_ count: Int) -> String { String(repeating: self, count: count) }
}
