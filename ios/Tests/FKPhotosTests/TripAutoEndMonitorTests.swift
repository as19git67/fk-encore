import XCTest
@testable import FKPhotosLib

/// The auto-end suggestion, observed (§2.1 of the UX plan).
///
/// The banner and the tab badge read the monitor's mirror, not the
/// store; the mirror has to follow the store, and clearing has to reach
/// both.
@MainActor
final class TripAutoEndMonitorTests: XCTestCase {
    private var saved: PendingAutoEndSuggestion?

    override func setUp() {
        super.setUp()
        saved = TripAutoEndPreferences.pendingSuggestion
    }

    override func tearDown() {
        TripAutoEndPreferences.pendingSuggestion = saved
        TripAutoEndMonitor.shared.reloadPendingSuggestion()
        super.tearDown()
    }

    func testTheMirrorFollowsTheStoreOnReload() {
        // The notification's actions can run in another process; what
        // they wrote has to show up here on the next foreground.
        let raised = PendingAutoEndSuggestion(tripIosAlbumId: "album-a", raisedAt: Date())
        TripAutoEndPreferences.pendingSuggestion = raised

        TripAutoEndMonitor.shared.reloadPendingSuggestion()

        XCTAssertEqual(TripAutoEndMonitor.shared.pendingSuggestion, raised)
    }

    func testDismissingClearsBothAndOnlyForThatTrip() {
        TripAutoEndPreferences.pendingSuggestion =
            PendingAutoEndSuggestion(tripIosAlbumId: "album-a", raisedAt: Date())
        TripAutoEndMonitor.shared.reloadPendingSuggestion()

        // Somebody else's trip: nothing happens.
        TripAutoEndMonitor.shared.dismissSuggestion(forTripAlbumId: "album-b")
        XCTAssertNotNil(TripAutoEndMonitor.shared.pendingSuggestion)

        TripAutoEndMonitor.shared.dismissSuggestion(forTripAlbumId: "album-a")
        XCTAssertNil(TripAutoEndMonitor.shared.pendingSuggestion)
        XCTAssertNil(TripAutoEndPreferences.pendingSuggestion)
    }
}
