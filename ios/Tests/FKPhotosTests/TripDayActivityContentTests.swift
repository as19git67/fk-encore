import XCTest
@testable import FKPhotosLib

/// What a Live Activity for a running trip day says, and when it says
/// nothing at all (#768 §1).
final class TripDayActivityContentTests: XCTestCase {

    private func stop(_ id: Int, osmRef: String, name: String, dwell: Int, travel: Int = 0) -> TripStop {
        TripStop(
            rowId: id,
            osmRef: osmRef,
            name: name,
            lat: 48.37,
            lon: 10.9,
            category: "sight",
            dwellMinutes: dwell,
            travelFromPrevious: TripTravel(minutes: travel, distanceM: travel * 75, travelClass: "short_walk"),
            status: "planned",
            pinned: false,
            note: nil,
            sourceUrl: nil,
            title: nil,
            localName: nil,
            wikipediaUrl: nil,
            photoStop: nil,
        )
    }

    private func block(_ id: String, start: Int?, budget: Int, kind: String = "spots", stops: [TripStop] = []) -> TripBlock {
        TripBlock(
            id: id, rowId: id.hashValue, label: id, kind: kind, budgetMinutes: budget,
            usedMinutes: stops.reduce(0) { $0 + $1.dwellMinutes + $1.travelFromPrevious.minutes },
            startMinutes: start, stops: stops, branches: nil,
        )
    }

    private func day(_ blocks: [TripBlock]) -> TripDay {
        TripDay(id: 1, dayIndex: 0, detailed: true, bufferReason: nil, blocks: blocks, fixpoints: [])
    }

    /// 09:00 "Vormittag" with two stops, 14:00 "Nachmittag" with one.
    private var sampleDay: TripDay {
        day([
            block("morning", start: 9 * 60, budget: 210, stops: [
                stop(1, osmRef: "node:1", name: "Museum", dwell: 90),
                stop(2, osmRef: "node:2", name: "Aussichtspunkt", dwell: 60, travel: 10),
            ]),
            block("afternoon", start: 14 * 60, budget: 210, stops: [
                stop(3, osmRef: "node:3", name: "Café", dwell: 45),
            ]),
        ])
    }

    func testSurfacesTheBlockAndPlannedStop() throws {
        let content = try XCTUnwrap(TripDayActivityContent.build(day: sampleDay, at: 9 * 60 + 30))

        XCTAssertEqual(content.blockLabel, "morning")
        XCTAssertEqual(content.currentStopName, "Museum")
        XCTAssertEqual(content.nextStopName, "Aussichtspunkt")
        XCTAssertFalse(content.stopConfirmed)
        XCTAssertEqual(content.overrunMinutes, 0)
    }

    func testAConfirmedStopWinsOverThePlansOwnGuess() throws {
        // The plan's clock would say "Museum" at this minute — but a
        // geofence says the group is actually still at the previous
        // stop, and that answer is the honest one.
        let content = try XCTUnwrap(TripDayActivityContent.build(
            day: sampleDay, at: 9 * 60 + 30, confirmedStopName: "Aussichtspunkt"
        ))

        XCTAssertEqual(content.currentStopName, "Aussichtspunkt")
        XCTAssertTrue(content.stopConfirmed)
    }

    func testCarriesTheOverrunFromAnEarlierBlock() throws {
        // Budget 60, a 50-minute stop, and 30 minutes carried in from an
        // earlier block that itself ran long: 30 + 50 - 60 = 20 over.
        var overrun = block("afternoon", start: 14 * 60, budget: 60, stops: [
            stop(3, osmRef: "node:3", name: "Café", dwell: 50),
        ])
        overrun.carriedInMinutes = 30
        let content = try XCTUnwrap(TripDayActivityContent.build(day: day([overrun]), at: 14 * 60 + 10))

        XCTAssertEqual(content.overrunMinutes, 20)
    }

    func testIsNilBeforeTheFirstBlockAndAfterTheLast() {
        XCTAssertNil(TripDayActivityContent.build(day: sampleDay, at: 6 * 60))
        XCTAssertNil(TripDayActivityContent.build(day: sampleDay, at: 22 * 60))
    }

    func testIsNilForABlockWithNoStartTime() {
        // A plan written before block times were kept (§8.3): no
        // honest answer exists, so none is given.
        let undated = day([block("morning", start: nil, budget: 210)])
        XCTAssertNil(TripDayActivityContent.build(day: undated, at: 9 * 60))
    }

    func testALightHintAppearsOnlyWhileItStillLiesAhead() throws {
        let window = TripLightWindow(kind: "golden", fromMinutes: 19 * 60 + 10, toMinutes: 19 * 60 + 40)
        let light = TripDayLight(
            day: "2027-07-01",
            windows: [window],
            spots: [TripSpotLight(osmRef: "node:1", best: window, facade: nil)]
        )

        let ahead = try XCTUnwrap(TripDayActivityContent.build(
            day: sampleDay, at: 9 * 60 + 30, lightHint: light
        ))
        XCTAssertEqual(ahead.lightHintText, "\(window.label) \(window.range)")

        let past = try XCTUnwrap(TripDayActivityContent.build(
            day: sampleDay, at: 9 * 60 + 30, confirmedStopName: nil,
            lightHint: TripDayLight(
                day: "2027-07-01",
                windows: [],
                spots: [TripSpotLight(
                    osmRef: "node:1",
                    best: TripLightWindow(kind: "golden", fromMinutes: 6 * 60, toMinutes: 7 * 60),
                    facade: nil
                )],
            )
        ))
        XCTAssertNil(past.lightHintText)
    }
}
