import XCTest
@testable import FKPhotosLib

/// Guards the one-time watermark-poison recovery migration. Installs that ran
/// the old auto-upload carry per-album watermarks pushed to wall-clock `Date()`;
/// the migration clears them once so the next sync re-enumerates and re-surfaces
/// the photos the bug left behind.
final class SyncMigrationTests: XCTestCase {

    // Must match PhotoSyncPreferences.albumSyncDatesKey — it is an on-disk
    // contract, so the literal is stable.
    private let albumSyncDatesKey = "sync.albumSyncDates"

    private func makeDefaults() -> (UserDefaults, String) {
        let suiteName = "test.watermark.migration.\(UUID().uuidString)"
        return (UserDefaults(suiteName: suiteName)!, suiteName)
    }

    func testMigrationClearsExistingWatermarks() {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }

        defaults.set(["albumA": Date(timeIntervalSince1970: 1000)], forKey: albumSyncDatesKey)

        PhotoSyncPreferences.runWatermarkPoisonMigrationIfNeeded(defaults: defaults)

        XCTAssertNil(
            defaults.dictionary(forKey: albumSyncDatesKey),
            "the one-time migration should clear the poisoned watermarks"
        )
    }

    func testMigrationRunsOnlyOnce() {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }

        // First run clears whatever was there and sets the guard flag.
        defaults.set(["albumA": Date(timeIntervalSince1970: 1000)], forKey: albumSyncDatesKey)
        PhotoSyncPreferences.runWatermarkPoisonMigrationIfNeeded(defaults: defaults)

        // Watermarks legitimately rebuilt by the fixed sync logic must survive a
        // second invocation — the migration is a no-op from here on.
        defaults.set(["albumB": Date(timeIntervalSince1970: 2000)], forKey: albumSyncDatesKey)
        PhotoSyncPreferences.runWatermarkPoisonMigrationIfNeeded(defaults: defaults)

        let after = defaults.dictionary(forKey: albumSyncDatesKey) as? [String: Date]
        XCTAssertEqual(
            after?["albumB"], Date(timeIntervalSince1970: 2000),
            "migration must not run a second time and wipe freshly built watermarks"
        )
    }

    func testMigrationIsSafeWithNoWatermarks() {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }

        // Fresh install: nothing to clear, must not crash and must still flip the
        // guard so it never runs again.
        PhotoSyncPreferences.runWatermarkPoisonMigrationIfNeeded(defaults: defaults)

        defaults.set(["albumA": Date(timeIntervalSince1970: 1000)], forKey: albumSyncDatesKey)
        PhotoSyncPreferences.runWatermarkPoisonMigrationIfNeeded(defaults: defaults)
        let after = defaults.dictionary(forKey: albumSyncDatesKey) as? [String: Date]
        XCTAssertEqual(after?["albumA"], Date(timeIntervalSince1970: 1000))
    }
}
