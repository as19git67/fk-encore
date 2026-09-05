import CoreLocation
import XCTest
@testable import FKPhotosLib

/// Noticing that a stop is done, on the device (§6.4, §7.1).
///
/// Everything here is the part that can be got wrong silently: a fence
/// too small to catch a park, a clock reset by a duplicate event just
/// before it qualifies, a photo from across town counted as proof. None
/// of it can be tested by walking around, which is exactly why it is
/// pure.
final class TripGeofencePlanTests: XCTestCase {
    private func stop(
        _ rowId: Int,
        category: String = "sight",
        status: String = "planned",
        dwellMinutes: Int = 30,
    ) -> TripStop {
        TripStop(
            rowId: rowId,
            osmRef: "node:\(rowId)",
            name: "Ort \(rowId)",
            lat: 48.37,
            lon: 10.9,
            category: category,
            dwellMinutes: dwellMinutes,
            travelFromPrevious: TripTravel(minutes: 10, distanceM: 800, travelClass: "short_walk"),
            status: status,
            pinned: false,
            note: nil,
            sourceUrl: nil,
        )
    }

    func testAParkGetsAWiderFenceThanAViewpoint() {
        // One radius for both either misses the viewpoint or counts the
        // walk past the park.
        XCTAssertGreaterThan(
            TripGeofencePlan.radius(for: "outdoors"),
            TripGeofencePlan.radius(for: "viewpoint"),
        )
    }

    func testAPlaceOfUnknownSizeGetsAMiddlingFence() {
        // "unknown" is what a find with no OpenStreetMap entry carries.
        let unknown = TripGeofencePlan.radius(for: "unknown")
        XCTAssertGreaterThan(unknown, TripGeofencePlan.radius(for: "viewpoint"))
        XCTAssertLessThan(unknown, TripGeofencePlan.radius(for: "outdoors"))
    }

    func testOnlyTheNextFewStopsAreWatched() {
        // Fencing the whole day is continuous tracking arrived at by a
        // different route (§7.1).
        let regions = TripGeofencePlan.regions(for: (1...6).map { stop($0) })
        XCTAssertEqual(regions.count, TripGeofencePlan.maximumRegions)
        XCTAssertEqual(regions.map(\.osmRef), ["node:1", "node:2"])
    }

    func testSettledStopsAreNotWatched() {
        // A fence around somewhere you have been is a wake-up with
        // nothing behind it; one around a stop you dropped on purpose
        // would ask about something you already said no to.
        let regions = TripGeofencePlan.regions(for: [
            stop(1, status: "done"),
            stop(2, status: "skipped"),
            stop(3),
            stop(4),
        ])
        XCTAssertEqual(regions.map(\.osmRef), ["node:3", "node:4"])
    }

    func testTheFenceCarriesWhatTheDwellRuleNeeds() {
        let regions = TripGeofencePlan.regions(for: [stop(1, category: "museum", dwellMinutes: 90)])
        XCTAssertEqual(regions.first?.plannedMinutes, 90)
        XCTAssertEqual(regions.first?.identifier, "node:1")
    }
}

final class TripDwellTrackerTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_700_000_000)

    private func at(_ minutes: Int) -> Date {
        start.addingTimeInterval(TimeInterval(minutes * 60))
    }

    func testAStayIsReportedOnlyWhenItEnds() {
        var tracker = TripDwellTracker()
        tracker.entered("node:1", at: at(0))
        // Nothing to report yet — the dwell is what counts, not the
        // entry, so an arrival on its own says nothing.
        XCTAssertEqual(tracker.openMinutes("node:1", now: at(25)), 25)

        let stay = tracker.exited("node:1", at: at(40))
        XCTAssertEqual(stay?.minutes, 40)
        XCTAssertEqual(stay?.arrivedAt, at(0))
    }

    func testARepeatedEntryDoesNotRestartTheClock() {
        // iOS re-delivers region events. Treating the second one as a
        // fresh arrival would reset the clock just as the dwell was
        // about to qualify.
        var tracker = TripDwellTracker()
        tracker.entered("node:1", at: at(0))
        tracker.entered("node:1", at: at(20))
        XCTAssertEqual(tracker.exited("node:1", at: at(30))?.minutes, 30)
    }

    func testAnExitWithNoEntryInventsNothing() {
        // The app woke up outside a region it never saw anyone enter.
        // There is no stay, and "now minus something" would be a
        // fabricated timestamp.
        var tracker = TripDwellTracker()
        XCTAssertNil(tracker.exited("node:1", at: at(10)))
    }

    func testAClockThatWentBackwardsProducesNoStay() {
        var tracker = TripDwellTracker()
        tracker.entered("node:1", at: at(30))
        XCTAssertNil(tracker.exited("node:1", at: at(10)))
    }

    func testAStayStillRunningIsNotAStayOfZeroMinutes() {
        var tracker = TripDwellTracker()
        tracker.entered("node:1", at: at(0))
        XCTAssertEqual(tracker.openMinutes("node:1", now: at(15)), 15)
        XCTAssertNil(tracker.openMinutes("node:2", now: at(15)))
    }

    func testClosingEverythingReportsWhatWasStillOpen() {
        // A museum you are standing in when the day rolls over is a
        // visit that happened.
        var tracker = TripDwellTracker()
        tracker.entered("node:2", at: at(30))
        tracker.entered("node:1", at: at(0))

        let stays = tracker.closeAll(at: at(60))

        XCTAssertEqual(stays.map(\.regionId), ["node:1", "node:2"])
        XCTAssertEqual(stays.first?.minutes, 60)
        XCTAssertTrue(tracker.openStays.isEmpty)
    }
}

final class TripDwellRuleTests: XCTestCase {
    func testTheThresholdIsTheLargerOfTheTwo() {
        // A quarter alone would let two minutes at a viewpoint count;
        // ten minutes alone would let a walk across a museum forecourt
        // count. The larger of the two is neither.
        XCTAssertEqual(TripDwellRule.thresholdMinutes(plannedMinutes: 20), 10)
        XCTAssertEqual(TripDwellRule.thresholdMinutes(plannedMinutes: 90), 23)
    }

    func testAWalkPastIsNotWorthReporting() {
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        let brief = TripStay(regionId: "node:1", arrivedAt: start,
                             departedAt: start.addingTimeInterval(4 * 60))
        let real = TripStay(regionId: "node:1", arrivedAt: start,
                            departedAt: start.addingTimeInterval(35 * 60))
        XCTAssertFalse(TripDwellRule.isWorthReporting(brief, plannedMinutes: 90))
        XCTAssertTrue(TripDwellRule.isWorthReporting(real, plannedMinutes: 90))
    }
}

final class TripPhotoSignalTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_700_000_000)

    private var region: TripMonitoredRegion {
        TripMonitoredRegion(
            osmRef: "node:1",
            name: "Stadtmuseum Beispielstadt",
            center: CLLocationCoordinate2D(latitude: 48.37, longitude: 10.9),
            radius: 100,
            plannedMinutes: 90,
        )
    }

    private var stay: TripStay {
        TripStay(regionId: "node:1", arrivedAt: start,
                 departedAt: start.addingTimeInterval(60 * 60))
    }

    /// ~55 m north of the centre: inside the 100 m fence.
    private var inside: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: 48.3705, longitude: 10.9)
    }

    /// ~1.1 km north: outside the fence and outside the slack.
    private var acrossTown: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: 48.38, longitude: 10.9)
    }

    func testAPhotoTakenThereDuringTheStayConfirmsIt() {
        let photo = TripPhotoSignal.Photo(
            takenAt: start.addingTimeInterval(20 * 60), coordinate: inside)
        XCTAssertTrue(TripPhotoSignal.confirms(stay, region: region, photos: [photo]))
    }

    func testAPhotoOfThePlaceFromAcrossTownDoesNot() {
        // A photo *of* the cathedral is not evidence of being *at* it,
        // and one signal pairs with a dwell to act without asking.
        let photo = TripPhotoSignal.Photo(
            takenAt: start.addingTimeInterval(20 * 60), coordinate: acrossTown)
        XCTAssertFalse(TripPhotoSignal.confirms(stay, region: region, photos: [photo]))
    }

    func testAPhotoFromAnotherAfternoonDoesNot() {
        let photo = TripPhotoSignal.Photo(
            takenAt: start.addingTimeInterval(6 * 60 * 60), coordinate: inside)
        XCTAssertFalse(TripPhotoSignal.confirms(stay, region: region, photos: [photo]))
    }

    func testTheClocksMayDisagreeALittle() {
        // A camera clock and a location fix rarely agree to the second,
        // and the fence fires on the boundary while the photo is taken
        // inside.
        let justBefore = TripPhotoSignal.Photo(
            takenAt: start.addingTimeInterval(-60), coordinate: inside)
        XCTAssertTrue(TripPhotoSignal.confirms(stay, region: region, photos: [justBefore]))
    }

    func testAPhotoWithNoLocationIsNotEvidenceEitherWay() {
        let photo = TripPhotoSignal.Photo(
            takenAt: start.addingTimeInterval(20 * 60), coordinate: nil)
        XCTAssertFalse(TripPhotoSignal.confirms(stay, region: region, photos: [photo]))
    }

    func testNoPhotosMeansNoSignal() {
        XCTAssertFalse(TripPhotoSignal.confirms(stay, region: region, photos: []))
    }
}
