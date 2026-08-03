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

    // MARK: - Image format detection from raw bytes
    //
    // Used by the PhotosPicker fallback path, which has no PHAsset to ask for a
    // uniformTypeIdentifier. It used to declare every such upload as
    // `image/jpeg`, storing PNGs under a `.jpg` name with a mismatching
    // Content-Type.

    private func bytes(_ values: [UInt8]) -> Data { Data(values) }

    func testDetectsPngFromMagicBytes() {
        let png = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00])
        XCTAssertEqual(AssetUploadEnqueuer.mimeType(forImageData: png), "image/png")
    }

    func testDetectsJpegFromMagicBytes() {
        let jpeg = bytes([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])
        XCTAssertEqual(AssetUploadEnqueuer.mimeType(forImageData: jpeg), "image/jpeg")
    }

    func testDetectsHeicFromBrandBox() {
        // ....ftypheic
        let heic = bytes([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
                          0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00])
        XCTAssertEqual(AssetUploadEnqueuer.mimeType(forImageData: heic), "image/heic")
    }

    func testDetectsWebpFromRiffContainer() {
        let webp = bytes([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
                          0x57, 0x45, 0x42, 0x50])
        XCTAssertEqual(AssetUploadEnqueuer.mimeType(forImageData: webp), "image/webp")
    }

    func testUnknownAndShortDataFallBackToJpeg() {
        XCTAssertEqual(AssetUploadEnqueuer.mimeType(forImageData: bytes([0x00, 0x01, 0x02])), "image/jpeg")
        XCTAssertEqual(AssetUploadEnqueuer.mimeType(forImageData: Data()), "image/jpeg")
    }

    func testDetectedPngDrivesTheFilenameExtension() {
        // The two helpers are used together on the fallback path — a PNG must
        // end up with a .png name, not the hardcoded .jpg it had before.
        let png = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        let mime = AssetUploadEnqueuer.mimeType(forImageData: png)
        XCTAssertEqual(AssetUploadEnqueuer.filenameMatchingMime("photo_123.jpg", mimeType: mime), "photo_123.png")
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
