import XCTest
@testable import F4milAssistant

/// The pure parts of following a turn: which replayed events are new, and
/// how often a dropped socket is opened again.
final class TurnFollowerTests: XCTestCase {
    func testAFreshSocketShowsEverything() {
        var cursor = ReplayCursor()
        XCTAssertTrue(cursor.admit())
        XCTAssertTrue(cursor.admit())
        XCTAssertEqual(cursor.seen, 2)
    }

    func testAReopenedSocketSkipsWhatWasShown() {
        var cursor = ReplayCursor()
        _ = cursor.admit()
        _ = cursor.admit()
        _ = cursor.admit()
        cursor.prepareReplay()
        // The server replays the three events seen, then sends the new ones.
        XCTAssertFalse(cursor.admit())
        XCTAssertFalse(cursor.admit())
        XCTAssertFalse(cursor.admit())
        XCTAssertTrue(cursor.admit())
        XCTAssertEqual(cursor.seen, 4)
    }

    func testASecondDropSkipsEverythingShownSoFarNotOnlyTheLastRound() {
        var cursor = ReplayCursor()
        _ = cursor.admit()
        cursor.prepareReplay()
        _ = cursor.admit()  // the replay of the first
        _ = cursor.admit()  // a new one
        cursor.prepareReplay()
        XCTAssertEqual(cursor.skip, 2)
    }

    func testTheReconnectsRunOutAsOnTheWeb() {
        XCTAssertEqual(TurnFollower.delay(forAttempt: 0), .seconds(1))
        XCTAssertEqual(TurnFollower.delay(forAttempt: 5), .seconds(30))
        XCTAssertNil(TurnFollower.delay(forAttempt: 6))
    }

    func testATurnIdFitsTheServersPattern() {
        let id = TurnID.make()
        XCTAssertTrue(TurnID.isValid(id), id)
        XCTAssertEqual(id.count, 32)
        XCTAssertFalse(TurnID.isValid("short"))
        XCTAssertFalse(TurnID.isValid("has space in it"))
        XCTAssertFalse(TurnID.isValid("umlaut-äöü-12345"))
        XCTAssertTrue(TurnID.isValid("abc_DEF-123"))
    }
}
