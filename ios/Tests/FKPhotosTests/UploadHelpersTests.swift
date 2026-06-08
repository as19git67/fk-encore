import XCTest
@testable import FKPhotosLib

/// Pure-logic guards for the filename/mime helpers shared by both upload paths
/// (issue #591). A mismatch here is how issue #333 (HEIC bytes sent with a
/// `.jpg` name) regressed before, so these lock the alignment.
final class UploadHelpersTests: XCTestCase {

    func testFilenameGetsHeicExtensionForHeicMime() {
        XCTAssertEqual(AssetUploadEnqueuer.filenameMatchingMime("photo.jpg", mimeType: "image/heic"), "photo.heic")
    }

    func testFilenameKeepsEquivalentHeicExtension() {
        // .heif ↔ .heic are equivalent — don't churn the user-visible name.
        XCTAssertEqual(AssetUploadEnqueuer.filenameMatchingMime("IMG_1.heif", mimeType: "image/heic"), "IMG_1.heif")
    }

    func testFilenameKeepsEquivalentJpegExtension() {
        XCTAssertEqual(AssetUploadEnqueuer.filenameMatchingMime("a.jpeg", mimeType: "image/jpeg"), "a.jpeg")
    }

    func testFilenameAddsExtensionWhenMissing() {
        XCTAssertEqual(AssetUploadEnqueuer.filenameMatchingMime("noext", mimeType: "image/png"), "noext.png")
    }

    func testFilenameFallsBackForEmptyStem() {
        XCTAssertEqual(AssetUploadEnqueuer.filenameMatchingMime("", mimeType: "image/jpeg"), "photo.jpg")
    }

    func testMimeTypeMappingFromUTI() {
        XCTAssertEqual(PhotoSyncService.mimeType(for: "public.heic"), "image/heic")
        XCTAssertEqual(PhotoSyncService.mimeType(for: "public.heif"), "image/heic")
        XCTAssertEqual(PhotoSyncService.mimeType(for: "public.png"), "image/png")
        XCTAssertEqual(PhotoSyncService.mimeType(for: "public.tiff"), "image/tiff")
        XCTAssertEqual(PhotoSyncService.mimeType(for: "org.webmproject.webp"), "image/webp")
        XCTAssertEqual(PhotoSyncService.mimeType(for: "public.jpeg"), "image/jpeg")
        // Unknown UTI defaults to JPEG.
        XCTAssertEqual(PhotoSyncService.mimeType(for: "com.example.unknown"), "image/jpeg")
    }
}
