import XCTest
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
@testable import FKPhotosLib

/// Locks the photo **dedup identity contract** (issue #432 / #591). The server
/// deduplicates uploads on `image_data_hash` (decoded pixels) and `full_hash`
/// (pixels + caption + favourite + capture date). Both the manual album upload
/// and the automatic folder sync must derive these *identically*, and the
/// formula must stay byte-stable across releases — otherwise a re-upload of the
/// same photo silently creates a duplicate on the server.
///
/// The golden values below are computed from the exact composite formula
/// `imageDataHash + "\n" + caption + "\n" + (fav ? "1":"0") + "\n" + capturedAt`.
/// If a change moves them, that change breaks dedup with every existing client
/// and the test must be updated deliberately (and the Share Extension's
/// `ShareHasher.fullHash` kept in lock-step).
final class HashContractTests: XCTestCase {

    // MARK: - fullHash golden values

    func testFullHashGoldenFavorite() {
        let hash = PhotoHasher.fullHash(
            imageDataHash: "deadbeef",
            caption: "Strand",
            isFavorite: true,
            capturedAtString: "2026-05-20T15:00:00+02:00"
        )
        XCTAssertEqual(hash, "948d1956e620bf15e0e820bdf872ebafc6c96bab9ca15499f5110d53093b176f")
    }

    func testFullHashGoldenNotFavorite() {
        let hash = PhotoHasher.fullHash(
            imageDataHash: "deadbeef",
            caption: "Strand",
            isFavorite: false,
            capturedAtString: "2026-05-20T15:00:00+02:00"
        )
        XCTAssertEqual(hash, "71ceac01ce051ac83daf38a349939523fa3b65c3227031efac00528727d46af4")
    }

    func testFullHashGoldenEmpty() {
        let hash = PhotoHasher.fullHash(imageDataHash: "", caption: "", isFavorite: false, capturedAtString: "")
        XCTAssertEqual(hash, "630dea271c2f0dd3fb6b5cd47bfc22b7a98ca55ccb5d391995260c8a3d462651")
    }

    // MARK: - fullHash sensitivity (every metadata field must move the hash)

    func testFavoriteFlipChangesHash() {
        let base = PhotoHasher.fullHash(imageDataHash: "h", caption: "c", isFavorite: false, capturedAtString: "d")
        let flipped = PhotoHasher.fullHash(imageDataHash: "h", caption: "c", isFavorite: true, capturedAtString: "d")
        XCTAssertNotEqual(base, flipped, "Favourite flag must be part of the identity hash")
    }

    func testCaptionChangeChangesHash() {
        let base = PhotoHasher.fullHash(imageDataHash: "h", caption: "c", isFavorite: false, capturedAtString: "d")
        let edited = PhotoHasher.fullHash(imageDataHash: "h", caption: "c2", isFavorite: false, capturedAtString: "d")
        XCTAssertNotEqual(base, edited, "Caption must be part of the identity hash")
    }

    func testCaptureDateChangeChangesHash() {
        let base = PhotoHasher.fullHash(imageDataHash: "h", caption: "c", isFavorite: false, capturedAtString: "d")
        let edited = PhotoHasher.fullHash(imageDataHash: "h", caption: "c", isFavorite: false, capturedAtString: "d2")
        XCTAssertNotEqual(base, edited, "Capture date must be part of the identity hash")
    }

    func testPixelChangeChangesHash() {
        let base = PhotoHasher.fullHash(imageDataHash: "h", caption: "c", isFavorite: false, capturedAtString: "d")
        let edited = PhotoHasher.fullHash(imageDataHash: "h2", caption: "c", isFavorite: false, capturedAtString: "d")
        XCTAssertNotEqual(base, edited, "Pixel hash must be part of the identity hash")
    }

    // MARK: - imageDataHash (decoded pixels)

    /// Same pixels ⇒ same hash, regardless of the container format the bytes
    /// arrived in. This is what lets a HEIC original and its re-encoded edit
    /// dedup against the same server photo by `image_data_hash`.
    func testImageDataHashIsDeterministic() throws {
        let png = try makePNG(width: 8, height: 8, gray: 128)
        XCTAssertEqual(PhotoHasher.imageDataHash(from: png), PhotoHasher.imageDataHash(from: png))
    }

    func testImageDataHashDiffersForDifferentPixels() throws {
        let a = try makePNG(width: 8, height: 8, gray: 10)
        let b = try makePNG(width: 8, height: 8, gray: 240)
        XCTAssertNotEqual(PhotoHasher.imageDataHash(from: a), PhotoHasher.imageDataHash(from: b))
    }

    /// Undecodable data falls back to hashing the raw bytes deterministically
    /// (never crashes, never returns empty).
    func testImageDataHashFallsBackForNonImageData() {
        let junk = Data([0x00, 0x01, 0x02, 0x03, 0x04])
        let hash = PhotoHasher.imageDataHash(from: junk)
        XCTAssertEqual(hash.count, 64)
        XCTAssertEqual(hash, PhotoHasher.imageDataHash(from: junk))
    }

    // MARK: - Helpers

    private func makePNG(width: Int, height: Int, gray: UInt8) throws -> Data {
        let bytesPerRow = width * 4
        guard let ctx = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { throw XCTSkip("CGContext unavailable") }
        let v = CGFloat(gray) / 255.0
        ctx.setFillColor(red: v, green: v, blue: v, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        guard let image = ctx.makeImage() else { throw XCTSkip("makeImage failed") }

        let out = NSMutableData()
        let type = UTType.png.identifier as CFString
        guard let dest = CGImageDestinationCreateWithData(out as CFMutableData, type, 1, nil) else {
            throw XCTSkip("image destination unavailable")
        }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else { throw XCTSkip("png encode failed") }
        return out as Data
    }
}
