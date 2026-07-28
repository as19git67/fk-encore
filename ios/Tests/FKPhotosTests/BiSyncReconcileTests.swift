import XCTest
@testable import FKPhotosLib

/// Locks the **bi-sync decision contract** on the iOS client side. The bi-sync
/// flow spans device ↔ server; the parts that involve the Photos library and
/// the network live in actors and can't run in CI, but their *decision cores*
/// are pure functions and are exercised here so a regression in the sync logic
/// fails the iOS unit-test job instead of shipping.
///
/// Scenario map (see also the backend `photo.bisync.test.ts`):
///  - S3  iOS-Löschung → Web-Album-Entfernung  → `computeAlbumRemovals`
///  - S4  Web-Album-Entfernung → iOS           → download reconcile + trash (server side tested in vitest)
///  - S6  Favorit Web → iOS                     → `reconcileAction` = .metadataOnly (favorite-only change never re-downloads)
///  - S8  Web-Beschreibung NICHT → iOS          → `reconcileAction` = .metadataOnly for camera originals (no caption write-back)
final class BiSyncReconcileTests: XCTestCase {

    // MARK: - S3: iOS deletion → server-album removal (PhotoSyncService.computeAlbumRemovals)

    /// A photo we uploaded whose local asset has left the iOS album is removed
    /// from the server album; one still present locally is kept.
    func testAlbumRemovalDropsLocallyMissing_keepsPresent() {
        let serverPhotoMap = ["10": "localA", "11": "localB"]
        let present: Set<String> = ["localA"]  // localB was deleted on device

        let removals = PhotoSyncService.computeAlbumRemovals(
            serverPhotoIds: [10, 11],
            serverPhotoMap: serverPhotoMap,
            presentLocalIds: present,
            bisyncTracked: nil
        )
        XCTAssertEqual(removals, [11], "Only the photo whose local asset left the album is removed")
    }

    /// A server photo this device never uploaded (absent from serverPhotoMap) is
    /// never removed — it isn't ours to reconcile.
    func testAlbumRemovalIgnoresUnmappedServerPhotos() {
        let removals = PhotoSyncService.computeAlbumRemovals(
            serverPhotoIds: [99],
            serverPhotoMap: [:],            // 99 not mapped to any local asset
            presentLocalIds: [],
            bisyncTracked: nil
        )
        XCTAssertTrue(removals.isEmpty, "Unmapped server photos are left untouched")
    }

    /// Bisync guard: a server photo that has NOT yet been downloaded for this
    /// album pair must never be removed, even if its (globally mapped) local
    /// asset isn't in the album — otherwise a web-side addition is deleted
    /// before it can sync down.
    func testAlbumRemovalBisyncGuardProtectsUndownloadedServerAdditions() {
        let serverPhotoMap = ["20": "localX"]   // localX exists (uploaded via another album)
        let present: Set<String> = []           // but not in THIS iOS album
        let tracked: Set<String> = []           // and not yet downloaded for this pair

        let removals = PhotoSyncService.computeAlbumRemovals(
            serverPhotoIds: [20],
            serverPhotoMap: serverPhotoMap,
            presentLocalIds: present,
            bisyncTracked: tracked
        )
        XCTAssertTrue(removals.isEmpty, "Bisync must not remove a server addition that hasn't been downloaded yet")
    }

    /// Bisync: once a server photo IS tracked (downloaded) for the pair and its
    /// local asset then leaves the album, it is removed.
    func testAlbumRemovalBisyncRemovesTrackedThenDeleted() {
        let removals = PhotoSyncService.computeAlbumRemovals(
            serverPhotoIds: [20],
            serverPhotoMap: ["20": "localX"],
            presentLocalIds: [],            // deleted from the iOS album
            bisyncTracked: ["20"]           // but previously downloaded for this pair
        )
        XCTAssertEqual(removals, [20], "A tracked photo whose local asset left the album is removed")
    }

    // MARK: - S6 / S8 / re-download: download reconcile decision (PhotoDownloadService.reconcileAction)

    private func state(
        pixel: String?,
        favorite: Bool = false,
        caption: String? = nil,
        full: String? = "full"
    ) -> DownloadSyncPreferences.DownloadedPhotoState {
        DownloadSyncPreferences.DownloadedPhotoState(
            hash: full,
            imageDataHash: pixel,
            updatedAt: nil,
            takenAt: nil,
            isFavorite: favorite,
            caption: caption
        )
    }

    func testReconcileSkipsWhenUnchanged() {
        let s = state(pixel: "p1", favorite: true, caption: "hi")
        XCTAssertEqual(
            PhotoDownloadService.reconcileAction(prev: s, next: s, isDownloaded: true),
            .skip
        )
    }

    /// S6: a favorite-only change (same pixels) is applied as metadata — it must
    /// NOT re-download, even for an app-downloaded asset.
    func testReconcileFavoriteOnlyChangeIsMetadataOnly() {
        let prev = state(pixel: "p1", favorite: false)
        let next = state(pixel: "p1", favorite: true, full: "full2")
        XCTAssertEqual(
            PhotoDownloadService.reconcileAction(prev: prev, next: next, isDownloaded: true),
            .metadataOnly,
            "A favorite flip must never trigger a pixel re-download"
        )
    }

    /// S8: a caption change on a NON-downloaded asset (a camera original) resolves
    /// to metadata-only — the caption is never written back to the device
    /// (the iOS restriction: web description does not propagate to iOS originals).
    func testReconcileCaptionChangeOnCameraOriginalDoesNotWriteCaption() {
        let prev = state(pixel: "p1", caption: "alt")
        let next = state(pixel: "p1", caption: "neu vom Web", full: "full2")
        XCTAssertEqual(
            PhotoDownloadService.reconcileAction(prev: prev, next: next, isDownloaded: false),
            .metadataOnly,
            "Web caption edits must not be written to a camera original"
        )
    }

    /// A caption change on an app-downloaded asset DOES propagate (into IPTC).
    func testReconcileCaptionChangeOnDownloadedWritesCaption() {
        let prev = state(pixel: "p1", caption: "alt")
        let next = state(pixel: "p1", caption: "neu vom Web", full: "full2")
        XCTAssertEqual(
            PhotoDownloadService.reconcileAction(prev: prev, next: next, isDownloaded: true),
            .metadataAndCaption
        )
    }

    /// A real server pixel change re-downloads — but only for an app-downloaded
    /// asset (a camera original is never replaced; the device owns its pixels).
    func testReconcilePixelChangeReplacesOnlyDownloaded() {
        let prev = state(pixel: "p1")
        let next = state(pixel: "p2", full: "full2")
        XCTAssertEqual(
            PhotoDownloadService.reconcileAction(prev: prev, next: next, isDownloaded: true),
            .replacePixels
        )
        XCTAssertEqual(
            PhotoDownloadService.reconcileAction(prev: prev, next: next, isDownloaded: false),
            .metadataOnly,
            "A camera original is never replaced even if the server pixels differ"
        )
    }

    /// A nil pixel hash on either side counts as "pixels unchanged" — a metadata
    /// edit on a legacy row must not be mistaken for a pixel change.
    func testReconcileNilPixelHashIsNotAPixelChange() {
        let prev = state(pixel: nil, caption: "a")
        let next = state(pixel: "p2", caption: "a", full: "full2")
        XCTAssertEqual(
            PhotoDownloadService.reconcileAction(prev: prev, next: next, isDownloaded: true),
            .metadataOnly,
            "A nil pixel hash must not be treated as a pixel change"
        )
    }

    // MARK: - Un-hide (reverse of hide→trash): PhotoDownloadService.unhideCandidates

    /// A hidden photo whose local asset is back in the iOS album (pulled out of
    /// "F4mil Trash") is pushed to `visible`; one still sitting in the trash
    /// (not an album member) is left hidden.
    func testUnhidePicksMemberButNotTrashResident() {
        let serverPhotoMap = ["30": "localBack", "31": "localTrash"]
        let members: Set<String> = ["localBack"]  // localTrash is still in F4mil Trash

        let toUnhide = PhotoDownloadService.unhideCandidates(
            hiddenServerPhotoIds: [30, 31],
            serverPhotoMap: serverPhotoMap,
            albumMemberLocalIds: members,
            includeHidden: false
        )
        XCTAssertEqual(toUnhide, [30], "Only the hidden photo whose asset is back in the album is un-hidden")
    }

    /// A hidden photo this device never mapped locally is never un-hidden — it
    /// isn't ours to reconcile.
    func testUnhideIgnoresUnmappedPhotos() {
        let toUnhide = PhotoDownloadService.unhideCandidates(
            hiddenServerPhotoIds: [99],
            serverPhotoMap: [:],            // 99 not mapped to any local asset
            albumMemberLocalIds: ["whatever"],
            includeHidden: false
        )
        XCTAssertTrue(toUnhide.isEmpty, "Unmapped hidden photos are left untouched")
    }

    /// With the hidden filter off there is no hide→trash semantics, so nothing is
    /// un-hidden even if a mapped asset is an album member.
    func testUnhideIsNoOpWhenIncludeHidden() {
        let toUnhide = PhotoDownloadService.unhideCandidates(
            hiddenServerPhotoIds: [30],
            serverPhotoMap: ["30": "localBack"],
            albumMemberLocalIds: ["localBack"],
            includeHidden: true
        )
        XCTAssertTrue(toUnhide.isEmpty, "includeHidden disables the hide/un-hide round-trip")
    }
}
