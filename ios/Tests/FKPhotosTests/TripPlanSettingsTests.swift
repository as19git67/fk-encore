import XCTest
@testable import FKPhotosLib

/// What the settings screen sends, and — more importantly — what it
/// does not (§6.2).
///
/// Two fields on this screen re-plan the trip and two do not, and the
/// difference is not cosmetic: a re-plan is refused outright once a day
/// has been ticked off. Sending the mode unchanged with every save
/// would turn "die Reise heißt jetzt anders" into a refusal halfway
/// through the holiday.
@MainActor
final class TripPlanSettingsTests: XCTestCase {

    private func model(mode: TripTransportMode = .foot,
                       startDate: String? = nil) -> TripPlanSettingsViewModel {
        TripPlanSettingsViewModel(planId: 1, constraints: nil, title: "Reise",
                                  mode: mode, startDate: startDate)
    }

    func testSayingNothingAboutTheDatesSendsNothing() {
        XCTAssertNil(model(startDate: "2026-09-17").dateChange ?? nil)
        XCTAssertNil(model().dateChange ?? nil)
        // And "not mentioned" is distinguishable from "take them off":
        // the outer optional is nil in the first case.
        XCTAssertNil(model(startDate: "2026-09-17").dateChange)
        XCTAssertNil(model().dateChange)
    }

    func testPuttingADateOnAnUndatedTrip() {
        let m = model()
        m.isDated = true
        m.startDate = TripCalendar.date(fromIsoDay: "2026-09-17")!
        XCTAssertEqual(m.dateChange, .some("2026-09-17"))
    }

    func testMovingTheDate() {
        let m = model(startDate: "2026-09-17")
        m.startDate = TripCalendar.date(fromIsoDay: "2026-10-01")!
        XCTAssertEqual(m.dateChange, .some("2026-10-01"))
    }

    func testTakingTheDatesOffIsAnExplicitNull() {
        // `.some(nil)` — the screen says "no dates", which is not the
        // same as saying nothing about them.
        let m = model(startDate: "2026-09-17")
        m.isDated = false
        let change = m.dateChange
        XCTAssertNotNil(change)
        XCTAssertNil(change ?? "not nil")
    }

    func testTheDateOpensOnTheDayItAlreadyHas() {
        let m = model(startDate: "2026-09-17")
        XCTAssertTrue(m.isDated)
        XCTAssertEqual(TripCalendar.isoDay(m.startDate), "2026-09-17")
    }

    func testTheModeStartsWhereTheTripIs() {
        XCTAssertEqual(model(mode: .transit).mode, .transit)
    }
}

/// The mode as the traveller reads it.
final class TripTransportModeLabelTests: XCTestCase {
    func testTransitDoesNotPromiseNeverToWalk() {
        // The planner walks any hop that is quicker on foot, which in an
        // old town is most of them. "Mit Öffentlichen" described a leg
        // that does not exist.
        XCTAssertEqual(TripTransportMode.transit.label, "ÖPNV & zu Fuß")
    }

    func testEveryModeSaysWhatItDoesToThePlan() {
        for mode in TripTransportMode.allCases {
            XCTAssertFalse(mode.hint.isEmpty)
            XCTAssertNotEqual(mode.label, mode.rawValue)
        }
    }
}
