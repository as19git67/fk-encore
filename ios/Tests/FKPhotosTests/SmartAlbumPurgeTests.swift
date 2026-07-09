import XCTest
@testable import FKPhotosLib

/// Guards the pure config-purge used by the legacy smart-album cleanup: a
/// config from before smart albums were hidden could still reference one via
/// the old settings picker, and it must be removed from every sync-config store
/// without touching the regular albums that stay.
final class SmartAlbumPurgeTests: XCTestCase {

    // On-disk key contract — must match PhotoSyncPreferences' private keys.
    private let selectedAlbumsKey   = "sync.selectedAlbumIds"
    private let confirmedMappingsKey = "sync.confirmedMappings"
    private let albumMappingsKey    = "sync.albumMappings"
    private let albumSyncModesKey   = "sync.albumSyncModes"
    private let albumSyncDatesKey   = "sync.albumSyncDates"

    private func makeDefaults() -> (UserDefaults, String) {
        let suiteName = "test.smartalbum.purge.\(UUID().uuidString)"
        return (UserDefaults(suiteName: suiteName)!, suiteName)
    }

    func testPurgeRemovesOnlyTargetedIdsFromEveryStore() {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }

        // "smart" is the legacy smart-album entry; "regular" must survive.
        defaults.set(["smart", "regular"], forKey: selectedAlbumsKey)
        defaults.set(["smart", "regular"], forKey: confirmedMappingsKey)
        defaults.set(["smart": 1, "regular": 2], forKey: albumMappingsKey)
        defaults.set(["smart": "sync", "regular": "copy"], forKey: albumSyncModesKey)
        defaults.set(["smart": Date(timeIntervalSince1970: 100),
                      "regular": Date(timeIntervalSince1970: 200)], forKey: albumSyncDatesKey)

        PhotoSyncPreferences.purgeAlbumsFromConfig(["smart"], defaults: defaults)

        XCTAssertEqual(Set(defaults.stringArray(forKey: selectedAlbumsKey) ?? []), ["regular"])
        XCTAssertEqual(Set(defaults.stringArray(forKey: confirmedMappingsKey) ?? []), ["regular"])
        XCTAssertEqual(defaults.dictionary(forKey: albumMappingsKey) as? [String: Int], ["regular": 2])
        XCTAssertEqual(defaults.dictionary(forKey: albumSyncModesKey) as? [String: String], ["regular": "copy"])
        let dates = defaults.dictionary(forKey: albumSyncDatesKey) as? [String: Date]
        XCTAssertNil(dates?["smart"])
        XCTAssertEqual(dates?["regular"], Date(timeIntervalSince1970: 200))
    }

    func testPurgeWithEmptySetIsANoOp() {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }

        defaults.set(["a", "b"], forKey: selectedAlbumsKey)
        PhotoSyncPreferences.purgeAlbumsFromConfig([], defaults: defaults)
        XCTAssertEqual(Set(defaults.stringArray(forKey: selectedAlbumsKey) ?? []), ["a", "b"])
    }

    func testPurgeIsSafeWhenStoresAreMissing() {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }

        // Nothing configured — must not crash and must leave the selection empty.
        PhotoSyncPreferences.purgeAlbumsFromConfig(["smart"], defaults: defaults)
        XCTAssertEqual(defaults.stringArray(forKey: selectedAlbumsKey) ?? [], [])
    }
}
