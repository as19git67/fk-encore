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

    // MARK: - Sync watermark advancement (iOS auto-upload incompleteness)
    //
    // Guards the rule that the per-album watermark must never advance past an
    // asset that failed to process this run. Before this, a failed-to-hash asset
    // (iCloud original not yet downloaded) older than the batch max was skipped
    // forever by the strict `creationDate >` enumeration predicate, leaving e.g.
    // 1400/1900 photos uploaded with the sync reporting "finished".

    private func date(_ epoch: TimeInterval) -> Date { Date(timeIntervalSince1970: epoch) }

    func testWatermarkAdvancesToNewestWhenNothingFailed() {
        let result = PhotoSyncService.safeWatermarks(
            processed: [("A", date(100)), ("A", date(300)), ("A", date(200))],
            earliestUnhashed: [:]
        )
        XCTAssertEqual(result["A"], date(300))
    }

    func testWatermarkDoesNotAdvancePastAFailedAsset() {
        // Asset at t=200 failed; processed t=100, t=300. The watermark must stop
        // below 200 so the next run re-includes the failed asset (and t=300).
        let result = PhotoSyncService.safeWatermarks(
            processed: [("A", date(100)), ("A", date(300))],
            earliestUnhashed: ["A": date(200)]
        )
        XCTAssertEqual(result["A"], date(100))
    }

    func testWatermarkNotSetWhenOldestAssetFailed() {
        // The earliest failure predates every processed asset → no safe advance.
        let result = PhotoSyncService.safeWatermarks(
            processed: [("A", date(300)), ("A", date(400))],
            earliestUnhashed: ["A": date(100)]
        )
        XCTAssertNil(result["A"])
    }

    func testWatermarkExcludesAssetSharingFailureTimestamp() {
        // A processed asset at exactly the failure timestamp must be excluded
        // (strict <), otherwise `creationDate > watermark` would skip the failed
        // asset that shares that second.
        let result = PhotoSyncService.safeWatermarks(
            processed: [("A", date(100)), ("A", date(200))],
            earliestUnhashed: ["A": date(200)]
        )
        XCTAssertEqual(result["A"], date(100))
    }

    func testWatermarkPerAlbumIndependent() {
        let result = PhotoSyncService.safeWatermarks(
            processed: [("A", date(100)), ("A", date(500)), ("B", date(100)), ("B", date(500))],
            earliestUnhashed: ["B": date(200)]
        )
        XCTAssertEqual(result["A"], date(500))
        XCTAssertEqual(result["B"], date(100))
    }
}
