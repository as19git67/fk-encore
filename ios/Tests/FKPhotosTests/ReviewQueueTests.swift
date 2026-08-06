import XCTest
@testable import FKPhotosLib

/// Pure-logic guards for the swipe review queue (#761). The card UI is verified
/// on-device; these lock the two things a regression would quietly break: the
/// gesture → decision mapping, and the one-deep undo buffer that decides which
/// decisions ever reach the server.
final class ReviewQueueTests: XCTestCase {

    // MARK: - Fixtures

    private func photo(
        _ id: Int,
        picked: Bool = false,
        quality: Double? = nil,
        curation: CurationStatus = .visible,
        peerHidden: Int = 0,
        peerFavorite: Int = 0
    ) -> ReviewQueuePhoto {
        ReviewQueuePhoto(
            id: id,
            filename: "p\(id).jpg",
            taken_at: nil,
            curation: curation,
            ai_picked: picked,
            ai_quality_score: quality,
            peer_curation: ReviewPeerCuration(hidden: peerHidden, favorite: peerFavorite)
        )
    }

    private func group(
        id: Int,
        photoIds: [Int] = [1, 2, 3],
        pickedIds: [Int]? = nil,
        confidence: String? = "high",
        peerHiddenOn: Int? = nil
    ) -> ReviewQueueGroup {
        let photos = photoIds.map {
            photo($0, picked: pickedIds?.contains($0) ?? false, peerHidden: $0 == peerHiddenOn ? 2 : 0)
        }
        return ReviewQueueGroup(
            id: id,
            cover_photo_id: photoIds.first,
            member_count: photoIds.count,
            ai_picked_photo_ids: pickedIds,
            ai_picked_confidence: confidence,
            runner_up_delta: 0.2,
            duplicate_candidate: false,
            duplicate_recommended_photo_id: nil,
            duplicate_deletable_count: 0,
            photos: photos
        )
    }

    // MARK: - Swipe resolution

    func testShortDragIsNotADecision() {
        XCTAssertNil(ReviewSwipe.resolve(translationWidth: 30, translationHeight: -20))
        XCTAssertNil(ReviewSwipe.resolve(translationWidth: 0, translationHeight: 0))
    }

    func testHorizontalSwipesMapToKeepPickAndKeepAll() {
        XCTAssertEqual(ReviewSwipe.resolve(translationWidth: 150, translationHeight: 5), .keepPick)
        XCTAssertEqual(ReviewSwipe.resolve(translationWidth: -150, translationHeight: 5), .keepAll)
    }

    func testUpwardSwipeIsFavorite() {
        XCTAssertEqual(ReviewSwipe.resolve(translationWidth: 10, translationHeight: -150), .favorite)
    }

    func testDownwardSwipeIsNotADecision() {
        // Pulling down must stay free for scrolling / dismissing, never decide.
        XCTAssertNil(ReviewSwipe.resolve(translationWidth: 0, translationHeight: 300))
    }

    func testDiagonalDragPrefersTheHorizontalDecision() {
        // A flick to the right that drifts slightly up must not favorite.
        XCTAssertEqual(ReviewSwipe.resolve(translationWidth: 200, translationHeight: -150), .keepPick)
    }

    // MARK: - Swipe → decision per group

    func testSwipesOnAGroupWithAnAiPick() {
        let g = group(id: 1, pickedIds: [2])
        XCTAssertEqual(ReviewSwipe.keepPick.decision(for: g), .acceptAiPick)
        XCTAssertEqual(ReviewSwipe.favorite.decision(for: g), .favoriteAndAccept)
        XCTAssertEqual(ReviewSwipe.keepAll.decision(for: g), .keepAll)
    }

    func testWithoutAnAiPickEverySwipeKeepsEverything() {
        // Hiding all members is not a decision the backend accepts, so a group
        // with no suggestion must never be resolved destructively by a flick.
        let g = group(id: 1, pickedIds: nil, confidence: nil)
        XCTAssertFalse(g.hasAiPick)
        for swipe in [ReviewSwipe.keepPick, .favorite, .keepAll] {
            XCTAssertEqual(swipe.decision(for: g), .keepAll, "\(swipe) must not hide anything")
        }
    }

    func testKeptPhotoIdsPerDecisionKind() {
        let g = group(id: 1, pickedIds: [2])
        XCTAssertEqual(ReviewDecision(group: g, kind: .acceptAiPick).keptPhotoIds, [2])
        XCTAssertEqual(ReviewDecision(group: g, kind: .favoriteAndAccept).keptPhotoIds, [2])
        XCTAssertEqual(ReviewDecision(group: g, kind: .pick([3])).keptPhotoIds, [3])
        XCTAssertEqual(ReviewDecision(group: g, kind: .keepAll).keptPhotoIds, [])
        XCTAssertEqual(ReviewDecision(group: g, kind: .peerConsensus).keptPhotoIds, [])
    }

    // MARK: - Group helpers

    func testAiPickIsSortedToTheFront() {
        let g = group(id: 1, photoIds: [1, 2, 3], pickedIds: [3])
        XCTAssertEqual(g.orderedPhotos.map(\.id), [3, 1, 2])
    }

    func testPeerSignalDetection() {
        XCTAssertFalse(group(id: 1, pickedIds: [1]).hasPeerSignal)
        XCTAssertTrue(group(id: 1, pickedIds: [1], peerHiddenOn: 2).hasPeerSignal)
    }

    func testConfidenceDecodesLenientlyForUnknownValues() {
        XCTAssertEqual(group(id: 1, confidence: "high").confidence, .high)
        XCTAssertNil(group(id: 1, confidence: "brand-new-stratum").confidence)
        XCTAssertNil(group(id: 1, confidence: nil).confidence)
    }

    // MARK: - Queue state: cursor + progress

    func testAppendSkipsGroupsAlreadyLoaded() {
        var state = ReviewQueueState()
        state.append([group(id: 1), group(id: 2)], total: 10)
        state.append([group(id: 2), group(id: 3)], total: 10)
        XCTAssertEqual(state.groups.map(\.id), [1, 2, 3])
    }

    func testTotalNeverUnderreportsWhatIsLoaded() {
        var state = ReviewQueueState()
        state.append([group(id: 1), group(id: 2), group(id: 3)], total: 1)
        XCTAssertEqual(state.total, 3)
    }

    func testCursorAdvancesAndExhausts() {
        var state = ReviewQueueState()
        state.append([group(id: 1), group(id: 2)], total: 2)
        XCTAssertEqual(state.current?.id, 1)
        state.decide(.keepAll)
        XCTAssertEqual(state.current?.id, 2)
        state.decide(.keepAll)
        XCTAssertNil(state.current)
        XCTAssertTrue(state.isExhausted)
    }

    func testProgressReachesOneWhenEverythingIsDecided() {
        var state = ReviewQueueState()
        state.append([group(id: 1), group(id: 2)], total: 2)
        XCTAssertEqual(state.progress, 0, accuracy: 0.0001)
        state.decide(.keepAll)
        XCTAssertEqual(state.progress, 0.5, accuracy: 0.0001)
        state.decide(.keepAll)
        XCTAssertEqual(state.progress, 1, accuracy: 0.0001)
    }

    func testProgressIsZeroOnAnEmptyQueue() {
        XCTAssertEqual(ReviewQueueState().progress, 0, accuracy: 0.0001)
    }

    func testDecidingOnAnEmptyQueueIsANoOp() {
        var state = ReviewQueueState()
        XCTAssertNil(state.decide(.keepAll))
        XCTAssertEqual(state.decidedCount, 0)
        XCTAssertFalse(state.canUndo)
    }

    // MARK: - The one-deep commit buffer

    func testFirstDecisionCommitsNothingYet() {
        var state = ReviewQueueState()
        state.append([group(id: 1), group(id: 2)], total: 2)
        // Nothing to push to the server yet — this decision is the one that
        // stays undoable.
        XCTAssertNil(state.decide(.acceptAiPick))
        XCTAssertTrue(state.canUndo)
    }

    func testSecondDecisionCommitsTheFirst() {
        var state = ReviewQueueState()
        state.append([group(id: 1), group(id: 2)], total: 2)
        state.decide(.acceptAiPick)
        let committed = state.decide(.keepAll)
        XCTAssertEqual(committed?.group.id, 1)
        XCTAssertEqual(committed?.kind, .acceptAiPick)
        // Only the newest one is still revocable.
        XCTAssertEqual(state.pending?.group.id, 2)
    }

    func testUndoTakesBackOnlyTheUncommittedDecision() {
        var state = ReviewQueueState()
        state.append([group(id: 1), group(id: 2)], total: 2)
        state.decide(.acceptAiPick)

        XCTAssertTrue(state.undo())
        XCTAssertEqual(state.current?.id, 1, "the card must come back")
        XCTAssertEqual(state.decidedCount, 0)
        XCTAssertFalse(state.canUndo, "undo is single-step, not a history")
    }

    func testUndoIsRefusedOnceTheDecisionWasCommitted() {
        var state = ReviewQueueState()
        state.append([group(id: 1), group(id: 2), group(id: 3)], total: 3)
        state.decide(.acceptAiPick)   // group 1 → pending
        state.decide(.keepAll)        // group 1 committed, group 2 → pending

        XCTAssertTrue(state.undo())   // takes group 2 back
        XCTAssertFalse(state.undo(), "group 1 already reached the server")
        XCTAssertEqual(state.current?.id, 2)
        XCTAssertEqual(state.decidedCount, 1)
    }

    func testUndoThenDecideAgainReplacesTheDecision() {
        var state = ReviewQueueState()
        state.append([group(id: 1), group(id: 2)], total: 2)
        state.decide(.acceptAiPick)
        state.undo()
        XCTAssertNil(state.decide(.keepAll), "nothing was committed before")
        XCTAssertEqual(state.pending?.kind, .keepAll)
        XCTAssertEqual(state.decidedCount, 1)
    }

    func testFlushHandsOverThePendingDecisionExactlyOnce() {
        var state = ReviewQueueState()
        state.append([group(id: 1)], total: 1)
        state.decide(.pick([2]))

        XCTAssertEqual(state.flush()?.kind, .pick([2]))
        XCTAssertNil(state.flush(), "a flushed decision must not be sent twice")
        XCTAssertFalse(state.canUndo)
        // Flushing commits — it must not rewind the cursor.
        XCTAssertEqual(state.decidedCount, 1)
    }

    func testResetClearsEverything() {
        var state = ReviewQueueState()
        state.append([group(id: 1), group(id: 2)], total: 2)
        state.decide(.keepAll)
        state.reset()
        XCTAssertTrue(state.groups.isEmpty)
        XCTAssertEqual(state.decidedCount, 0)
        XCTAssertNil(state.pending)
        XCTAssertNil(state.current)
    }

    // MARK: - Wire format

    func testResponseDecodesFromTheServerShape() throws {
        let json = """
        {
          "total": 42,
          "high_confidence_total": 12,
          "offset": 0,
          "groups": [
            {
              "id": 7,
              "cover_photo_id": 100,
              "member_count": 2,
              "ai_picked_photo_ids": [101],
              "ai_picked_confidence": "medium",
              "runner_up_delta": 0.08,
              "duplicate_candidate": true,
              "duplicate_recommended_photo_id": 101,
              "duplicate_deletable_count": 1,
              "duplicate_deletable_bytes": 2048,
              "photos": [
                {
                  "id": 101,
                  "filename": "a.jpg",
                  "taken_at": null,
                  "curation": "visible",
                  "ai_picked": true,
                  "ai_quality_score": 0.82,
                  "peer_curation": { "hidden": 0, "favorite": 2 }
                },
                {
                  "id": 102,
                  "filename": "b.jpg",
                  "taken_at": "2026-01-01T10:00:00Z",
                  "curation": "hidden",
                  "ai_picked": false,
                  "ai_quality_score": null,
                  "peer_curation": { "hidden": 1, "favorite": 0 }
                }
              ]
            }
          ],
          "user_calibration": null
        }
        """.data(using: .utf8)!

        let response = try JSONDecoder().decode(ReviewQueueResponse.self, from: json)
        XCTAssertEqual(response.total, 42)
        let g = try XCTUnwrap(response.groups.first)
        XCTAssertEqual(g.confidence, .medium)
        XCTAssertEqual(g.pickedPhotoIds, [101])
        XCTAssertTrue(g.isDuplicateCandidate)
        XCTAssertTrue(g.hasPeerSignal)
        XCTAssertEqual(g.photos.first?.qualityPercent, 82)
        XCTAssertNil(g.photos.last?.ai_quality_score)
        XCTAssertEqual(g.photos.last?.curation, .hidden)
    }

    func testGroupDecodesWithoutTheOptionalDuplicateFields() throws {
        // An older server predating the duplicate detection must not break the
        // whole queue.
        let json = """
        {
          "id": 3,
          "cover_photo_id": null,
          "member_count": 1,
          "ai_picked_photo_ids": null,
          "ai_picked_confidence": null,
          "runner_up_delta": null,
          "photos": []
        }
        """.data(using: .utf8)!

        let g = try JSONDecoder().decode(ReviewQueueGroup.self, from: json)
        XCTAssertFalse(g.hasAiPick)
        XCTAssertFalse(g.isDuplicateCandidate)
        XCTAssertNil(g.confidence)
    }
}
