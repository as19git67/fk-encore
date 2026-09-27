import CoreLocation
import XCTest
@testable import FKPhotosLib

/// What the visit monitor keeps across a relaunch (§7.1).
///
/// iOS keeps the fences after the app is terminated and relaunches it
/// in the background when one is crossed. Out of the first trial: the
/// app then woke knowing nothing about them, and the visit was lost.
final class TripVisitMonitorStateTests: XCTestCase {

    private var store: UserDefaults!

    override func setUp() {
        super.setUp()
        let suite = "TripVisitMonitorStateTests.\(UUID().uuidString)"
        store = UserDefaults(suiteName: suite)
        store.removePersistentDomain(forName: suite)
    }

    private let church = TripMonitoredRegion(
        osmRef: "node:1", name: "Kirche am Platz",
        center: CLLocationCoordinate2D(latitude: 45.88, longitude: 10.84),
        radius: 60, plannedMinutes: 30,
    )

    func testNothingStoredIsNothingKnown() {
        XCTAssertNil(TripVisitMonitorState.load(from: store))
    }

    func testTheFencesThePlanAndAnOpenStaySurviveARelaunch() throws {
        let quarters = TripGeofencePlan.anchorRegion(
            legId: 7, anchor: TripCoordinate(lat: 45.87, lon: 10.86), radiusM: nil)
        let arrived = Date(timeIntervalSince1970: 1_788_600_000)
        TripVisitMonitorState(
            planId: 12, dayIndex: 1,
            regions: [church, quarters],
            stopIds: ["node:1": 99],
            openStays: ["node:1": arrived],
            openStopOsmRef: "node:1",
        ).save(to: store)

        let restored = try XCTUnwrap(TripVisitMonitorState.load(from: store))
        XCTAssertEqual(restored.planId, 12)
        XCTAssertEqual(restored.dayIndex, 1)
        XCTAssertEqual(restored.stopIds, ["node:1": 99])
        XCTAssertEqual(restored.openStays["node:1"], arrived)
        XCTAssertEqual(restored.openStopOsmRef, "node:1")

        let byId = Dictionary(uniqueKeysWithValues: restored.regions.map { ($0.identifier, $0) })
        let church = try XCTUnwrap(byId["node:1"])
        XCTAssertEqual(church, self.church)
        XCTAssertEqual(church.name, "Kirche am Platz")
        XCTAssertEqual(church.plannedMinutes, 30)
        XCTAssertEqual(church.kind, .stop)
        XCTAssertEqual(byId["anchor:7"]?.kind, .quarters)
    }

    func testAStayMeasuredFromTheRestoredArrival() throws {
        let arrived = Date(timeIntervalSince1970: 1_788_600_000)
        TripVisitMonitorState(
            planId: 12, dayIndex: 0, regions: [church], stopIds: [:],
            openStays: ["node:1": arrived], openStopOsmRef: nil,
        ).save(to: store)

        let restored = try XCTUnwrap(TripVisitMonitorState.load(from: store))
        var tracker = TripDwellTracker(openStays: restored.openStays)
        let stay = try XCTUnwrap(tracker.exited("node:1", at: arrived.addingTimeInterval(40 * 60)))
        XCTAssertEqual(stay.minutes, 40)
    }

    func testClearingForgetsIt() {
        TripVisitMonitorState(
            planId: 1, dayIndex: 0, regions: [], stopIds: [:], openStays: [:], openStopOsmRef: nil,
        ).save(to: store)
        TripVisitMonitorState.clear(from: store)
        XCTAssertNil(TripVisitMonitorState.load(from: store))
    }
}
