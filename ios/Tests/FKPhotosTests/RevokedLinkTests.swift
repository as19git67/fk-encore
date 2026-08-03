import XCTest
@testable import FKPhotosLib

/// A link can point at an album somebody else owns (issue #812). When that share
/// is withdrawn the link must go quiet instead of retrying forever — but a
/// transient hiccup must never be mistaken for a withdrawal.
final class RevokedLinkTests: XCTestCase {

    func testLinkToAWritableAlbumIsNotRevoked() {
        let revoked = PhotoSyncPreferences.computeRevokedLinks(
            mappings: ["ios-1": 7],
            confirmed: ["ios-1"],
            writableServerAlbumIds: [7]
        )
        XCTAssertTrue(revoked.isEmpty)
    }

    /// Share removed entirely, or the album deleted: it simply stops appearing
    /// among the albums we may write to.
    func testLinkToAVanishedAlbumIsRevoked() {
        let revoked = PhotoSyncPreferences.computeRevokedLinks(
            mappings: ["ios-1": 7],
            confirmed: ["ios-1"],
            writableServerAlbumIds: []
        )
        XCTAssertEqual(revoked, ["ios-1"])
    }

    /// Downgrade to read-only is the subtle case: the album is still visible,
    /// but every upload into it would 403.
    func testLinkDowngradedToReadOnlyIsRevoked() {
        // The caller passes only *writable* ids, so a read-only album is absent
        // for the same reason a deleted one is.
        let revoked = PhotoSyncPreferences.computeRevokedLinks(
            mappings: ["ios-1": 7, "ios-2": 8],
            confirmed: ["ios-1", "ios-2"],
            writableServerAlbumIds: [8]
        )
        XCTAssertEqual(revoked, ["ios-1"])
    }

    /// An unconfirmed link is already skipped by the engine, so parking it would
    /// only produce a scary badge for a link that was never active.
    func testUnconfirmedLinksAreNeverRevoked() {
        let revoked = PhotoSyncPreferences.computeRevokedLinks(
            mappings: ["ios-1": 7],
            confirmed: [],
            writableServerAlbumIds: []
        )
        XCTAssertTrue(revoked.isEmpty)
    }

    func testEachLinkIsJudgedIndependently() {
        let revoked = PhotoSyncPreferences.computeRevokedLinks(
            mappings: ["ios-1": 7, "ios-2": 8, "ios-3": 9],
            confirmed: ["ios-1", "ios-2", "ios-3"],
            writableServerAlbumIds: [8]
        )
        XCTAssertEqual(revoked, ["ios-1", "ios-3"])
    }

    /// The set is recomputed from scratch on every run, so restoring access is
    /// enough to bring a link back — no manual repair step.
    func testRestoredAccessClearsTheRevocation() {
        let mappings = ["ios-1": 7]
        let confirmed: Set<String> = ["ios-1"]

        let whileRevoked = PhotoSyncPreferences.computeRevokedLinks(
            mappings: mappings, confirmed: confirmed, writableServerAlbumIds: []
        )
        XCTAssertEqual(whileRevoked, ["ios-1"])

        let afterRestore = PhotoSyncPreferences.computeRevokedLinks(
            mappings: mappings, confirmed: confirmed, writableServerAlbumIds: [7]
        )
        XCTAssertTrue(afterRestore.isEmpty)
    }

    /// The whole-library sentinel can carry a mapping too, and an upload into a
    /// revoked album fails no matter how the assets were enumerated.
    func testWholeLibrarySentinelIsJudgedLikeAnyOtherLink() {
        let revoked = PhotoSyncPreferences.computeRevokedLinks(
            mappings: [PhotoSyncPreferences.allLibrarySentinel: 7],
            confirmed: [PhotoSyncPreferences.allLibrarySentinel],
            writableServerAlbumIds: []
        )
        XCTAssertEqual(revoked, [PhotoSyncPreferences.allLibrarySentinel])
    }

    func testNoLinksMeansNothingToRevoke() {
        let revoked = PhotoSyncPreferences.computeRevokedLinks(
            mappings: [:],
            confirmed: ["ios-1"],
            writableServerAlbumIds: []
        )
        XCTAssertTrue(revoked.isEmpty)
    }
}
