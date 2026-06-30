import XCTest
@testable import FKPhotosLib

/// Pure-logic guards for the story player's advance/seek state machine (#759).
/// The SwiftUI player is verified on-device; these lock the timing math.
final class RecapPlaybackTests: XCTestCase {

    func testInitialState() {
        let p = RecapPlayback(count: 3)
        XCTAssertEqual(p.index, 0)
        XCTAssertEqual(p.progress, 0)
        XCTAssertFalse(p.finished)
    }

    func testEmptyStartsFinished() {
        XCTAssertTrue(RecapPlayback(count: 0).finished)
    }

    func testTickFillsCurrentSegment() {
        var p = RecapPlayback(count: 2)
        p.tick(delta: 2, perItem: 4)
        XCTAssertEqual(p.index, 0)
        XCTAssertEqual(p.progress, 0.5, accuracy: 0.0001)
        XCTAssertFalse(p.finished)
    }

    func testTickAdvancesToNextSlideCarryingRemainder() {
        var p = RecapPlayback(count: 3)
        p.tick(delta: 5, perItem: 4) // 1.25 segments → index 1, progress 0.25
        XCTAssertEqual(p.index, 1)
        XCTAssertEqual(p.progress, 0.25, accuracy: 0.0001)
        XCTAssertFalse(p.finished)
    }

    func testTickFinishesAfterLastSlide() {
        var p = RecapPlayback(count: 2)
        p.tick(delta: 4, perItem: 4) // completes slide 0 → index 1
        XCTAssertEqual(p.index, 1)
        p.tick(delta: 4, perItem: 4) // completes slide 1 → finished
        XCTAssertTrue(p.finished)
        XCTAssertEqual(p.fillFraction(for: 1), 1, accuracy: 0.0001)
    }

    func testTickIgnoredOnceFinished() {
        var p = RecapPlayback(count: 1)
        p.tick(delta: 4, perItem: 4)
        XCTAssertTrue(p.finished)
        let before = p
        p.tick(delta: 4, perItem: 4)
        XCTAssertEqual(p, before)
    }

    func testNextAdvancesAndResetsProgress() {
        var p = RecapPlayback(count: 3)
        p.tick(delta: 2, perItem: 4)
        p.next()
        XCTAssertEqual(p.index, 1)
        XCTAssertEqual(p.progress, 0)
        XCTAssertFalse(p.finished)
    }

    func testNextOnLastFinishes() {
        var p = RecapPlayback(count: 2)
        p.next() // → index 1
        p.next() // → finished
        XCTAssertTrue(p.finished)
    }

    func testPreviousClampsAtFirst() {
        var p = RecapPlayback(count: 3)
        p.previous()
        XCTAssertEqual(p.index, 0)
        XCTAssertEqual(p.progress, 0)
    }

    func testPreviousGoesBackAndClearsFinished() {
        var p = RecapPlayback(count: 2)
        p.next(); p.next() // finished on last
        XCTAssertTrue(p.finished)
        p.previous()
        XCTAssertFalse(p.finished)
        XCTAssertEqual(p.index, 0)
    }

    func testFillFractionPastAndFuture() {
        var p = RecapPlayback(count: 3)
        p.tick(delta: 4, perItem: 4) // index 1
        XCTAssertEqual(p.fillFraction(for: 0), 1, accuracy: 0.0001)
        XCTAssertEqual(p.fillFraction(for: 2), 0, accuracy: 0.0001)
    }
}
