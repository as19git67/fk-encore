import XCTest
@testable import FKPhotosLib

/// The bar under a spot's details (reise-planen-und-unterwegs, mock
/// "Spot-Details"): Route and Karte are its own, the move to another
/// day stands next to them, and everything else is under "Mehr".
@MainActor
final class TripSpotDetailBarTests: XCTestCase {
    private func action(_ id: String, group: TripSpotActionGroup = .plan) -> TripPinSheetAction {
        TripPinSheetAction(id: id, title: id, systemImage: "circle", group: group) {}
    }

    func testAPlannedStopPutsTheMoveInTheBar() {
        let bar = TripSpotDetailBar.planned([
            action("done", group: .status),
            action("route", group: .navigate),
            action("showOnMap", group: .navigate),
            action("move"),
            action("toPool"),
        ])
        XCTAssertEqual(bar.primary?.id, "move")
        XCTAssertEqual(bar.primaryTitle, "Anderer Tag")
        // The bar draws Route and Karte itself; "Mehr" holds the rest once.
        XCTAssertEqual(bar.more.map(\.id), ["done", "toPool"])
    }

    func testAStopThatCannotMoveHasNoThirdButton() {
        let bar = TripSpotDetailBar.planned([action("done", group: .status), action("toPool")])
        XCTAssertNil(bar.primary)
        XCTAssertNil(bar.primaryTitle)
        XCTAssertEqual(bar.more.map(\.id), ["done", "toPool"])
    }
}
