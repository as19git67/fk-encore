import UIKit
import XCTest
@testable import FKPhotosLib

/// The disk half of `ImageCache` had no upper bound: nothing ever called
/// `clearDisk()`, so it grew forever. These tests are against a real,
/// throwaway directory — `enforceDiskCacheLimit()` is a `FileManager` pass,
/// not something worth mocking.
final class ImageCacheDiskLimitTests: XCTestCase {

    private var directory: URL!
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ImageCacheDiskLimitTests-\(UUID().uuidString)", isDirectory: true)
        suiteName = "ImageCacheDiskLimitTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
        defaults.removePersistentDomain(forName: suiteName)
    }

    /// Writes `count` one-byte-per-unit files, oldest first, so the test can
    /// reason about eviction order without depending on real image encoding.
    private func writeFiles(_ sizes: [Int]) {
        for (i, size) in sizes.enumerated() {
            let url = directory.appendingPathComponent("file-\(i)")
            try? Data(repeating: 0, count: size).write(to: url)
            // Each file strictly older than the next, so sort order is
            // unambiguous regardless of filesystem timestamp resolution.
            let date = Date(timeIntervalSince1970: TimeInterval(i))
            try? FileManager.default.setAttributes([.modificationDate: date], ofItemAtPath: url.path)
        }
    }

    func testLeavesEverythingUntouchedWhenUnderTheCap() async throws {
        let cache = ImageCache(directory: directory, maxDiskBytes: 1_000, defaults: defaults)
        writeFiles([100, 100, 100])

        await cache.enforceDiskCacheLimit()

        let remaining = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        XCTAssertEqual(remaining.count, 3)
    }

    func testDeletesTheOldestFilesFirstUntilBackUnderTheCap() async throws {
        let cache = ImageCache(directory: directory, maxDiskBytes: 250, defaults: defaults)
        // file-0 (oldest) .. file-4 (newest), 100 bytes each = 500 total.
        writeFiles([100, 100, 100, 100, 100])

        await cache.enforceDiskCacheLimit()

        let remaining = Set(try FileManager.default.contentsOfDirectory(atPath: directory.path))
        // Deleting oldest-first stops as soon as the total is <= 250: two
        // deletions (500 -> 400 -> 300) are not enough, three is (-> 200).
        XCTAssertEqual(remaining, ["file-3", "file-4"])
    }

    func testADiskHitRefreshesTheFileSoItSurvivesTheNextEviction() async throws {
        // "touched" starts out older than either plain file — `image(forKey:)`
        // only touches files it can actually decode, so it needs to be a real
        // (tiny) JPEG. Its exact size is whatever the encoder produces; the
        // cap below is built from that measured size, not a guessed constant.
        let jpeg = try XCTUnwrap(UIImage(systemName: "photo")?.jpegData(compressionQuality: 0.5))
        // Constructing the cache is what creates `directory` — do this before
        // writing anything into it (unlike the other tests, this one writes
        // outside of `writeFiles`, which is easy to get backwards).
        let cache = ImageCache(directory: directory, maxDiskBytes: jpeg.count + 50, defaults: defaults)

        let touchedURL = directory.appendingPathComponent("touched")
        try jpeg.write(to: touchedURL)
        try FileManager.default.setAttributes(
            [.modificationDate: Date(timeIntervalSince1970: -1)],
            ofItemAtPath: touchedURL.path
        )
        writeFiles([100, 100]) // file-0 @ t=0, file-1 @ t=1 — both newer than "touched", for now.

        _ = await cache.image(forKey: "touched")

        await cache.enforceDiskCacheLimit()

        // The refresh on read made "touched" the newest of the three, so
        // eviction takes file-0 and file-1 first — both 100-byte files must
        // go to get under `jpeg.count + 50`, and only "touched" is left,
        // despite having been the oldest file on disk a moment ago.
        let remaining = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        XCTAssertEqual(remaining, ["touched"])
    }

    func testRunMaintenanceIfNeededSkipsWithinTheInterval() async throws {
        let cache = ImageCache(
            directory: directory, maxDiskBytes: 10, maintenanceInterval: 3600, defaults: defaults
        )
        writeFiles([100])
        let start = Date(timeIntervalSince1970: 1_000_000)

        await cache.runMaintenanceIfNeeded(now: start)
        var remaining = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        XCTAssertEqual(remaining.count, 0, "the first call is never skipped")

        writeFiles([100])
        await cache.runMaintenanceIfNeeded(now: start.addingTimeInterval(60))
        remaining = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        XCTAssertEqual(remaining.count, 1, "within the interval: skipped, so the new file survives")

        await cache.runMaintenanceIfNeeded(now: start.addingTimeInterval(3601))
        remaining = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        XCTAssertEqual(remaining.count, 0, "past the interval: runs again")
    }
}
