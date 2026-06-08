import XCTest
@testable import FKPhotosLib

/// Locks the `UploadQueue` claim/lifecycle invariants. The atomic
/// `pending → uploading` claim is what stopped two concurrent drains from
/// grabbing the same item and producing the ~10 % server-side duplicate photos
/// (see BackgroundSyncManager). A regression here is invisible in the UI but
/// re-introduces duplicates, so it is worth a hard test.
///
/// The queue is an App-Group-backed singleton; in the test bundle there is no
/// app-group entitlement, so it transparently falls back to a temp-dir file and
/// never touches real app data. Each test empties the queue first for
/// determinism.
final class UploadQueueTests: XCTestCase {

    override func setUp() async throws {
        try await super.setUp()
        await emptyQueue()
    }

    override func tearDown() async throws {
        await emptyQueue()
        try await super.tearDown()
    }

    private func emptyQueue() async {
        await UploadQueue.shared.cancelPending()    // pending + uploading
        await UploadQueue.shared.removeAllFailed()  // failed
        await UploadQueue.shared.purgeDone()        // done
    }

    private func makeItem(_ marker: String) -> UploadQueueItem {
        UploadQueueItem(
            assetLocalIdentifier: marker,
            filename: "\(marker).jpg",
            mimeType: "image/jpeg",
            imageDataHash: "hash_\(marker)",
            fullHash: "full_\(marker)",
            caption: "",
            isFavorite: false,
            capturedAtString: ""
        )
    }

    func testEnqueueMarksItemPending() async {
        let item = makeItem("a")
        await UploadQueue.shared.enqueue(item)
        let pending = await UploadQueue.shared.pendingItems()
        XCTAssertEqual(pending.map(\.id), [item.id])
    }

    /// The core invariant: a claimed item leaves the pending set and each item
    /// is handed out at most once.
    func testClaimHandsOutEachItemExactlyOnce() async {
        let a = makeItem("a")
        let b = makeItem("b")
        await UploadQueue.shared.enqueue(a)
        await UploadQueue.shared.enqueue(b)

        let first = await UploadQueue.shared.claimNextPending()
        let second = await UploadQueue.shared.claimNextPending()
        let third = await UploadQueue.shared.claimNextPending()

        XCTAssertNotNil(first)
        XCTAssertNotNil(second)
        XCTAssertNil(third, "no third item should be claimable")
        XCTAssertEqual(Set([first!.id, second!.id]), Set([a.id, b.id]))

        // A claimed item is no longer visible as pending (it is .uploading).
        let pendingAfter = await UploadQueue.shared.pendingItems()
        XCTAssertTrue(pendingAfter.isEmpty)
    }

    func testMarkPendingRequeuesAClaimedItem() async {
        let a = makeItem("a")
        await UploadQueue.shared.enqueue(a)
        _ = await UploadQueue.shared.claimNextPending()
        await UploadQueue.shared.markPending(id: a.id)
        let pending = await UploadQueue.shared.pendingItems()
        XCTAssertEqual(pending.map(\.id), [a.id])
    }

    func testMarkDoneThenPurgeRemovesItem() async {
        let a = makeItem("a")
        await UploadQueue.shared.enqueue(a)
        _ = await UploadQueue.shared.claimNextPending()
        await UploadQueue.shared.markDone(id: a.id)
        await UploadQueue.shared.purgeDone()
        let count = await UploadQueue.shared.inFlightCount()
        XCTAssertEqual(count, 0)
    }

    /// Transient (network) failures are requeued on foreground resume;
    /// permanent ones stay failed so they don't loop forever.
    func testRequeueTransientFailuresOnlyRetriesTransientErrors() async {
        let transient = makeItem("net")
        let permanent = makeItem("perm")
        await UploadQueue.shared.enqueue(transient)
        await UploadQueue.shared.enqueue(permanent)
        _ = await UploadQueue.shared.claimNextPending()
        _ = await UploadQueue.shared.claimNextPending()
        await UploadQueue.shared.markFailed(id: transient.id, error: "The request timed out")
        await UploadQueue.shared.markFailed(id: permanent.id, error: "permission denied")

        await UploadQueue.shared.requeueTransientFailures()

        let pending = await UploadQueue.shared.pendingItems().map(\.id)
        XCTAssertEqual(pending, [transient.id], "only the timed-out item should be retried")
    }

    func testCancelPendingClearsPendingAndUploading() async {
        await UploadQueue.shared.enqueue(makeItem("a"))
        let b = makeItem("b")
        await UploadQueue.shared.enqueue(b)
        _ = await UploadQueue.shared.claimNextPending() // one becomes .uploading

        await UploadQueue.shared.cancelPending()

        let inFlight = await UploadQueue.shared.inFlightCount()
        XCTAssertEqual(inFlight, 0)
    }
}
