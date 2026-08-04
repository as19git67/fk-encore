import CoreLocation
import XCTest
@testable import FKPhotosLib

/// Locks the **trip capture-window contract**. The auto-add pass itself needs a
/// photo library and can't run in CI, but its decision core (`TripMembership`)
/// is pure and is exercised here.
///
/// The rule that matters most: an ended trip keeps getting caught up — the app
/// only sees the photo library while it runs, so photos taken with the Camera
/// app are routinely discovered after the fact — but its `endedAt` is a hard
/// upper bound. Nothing shot after the user ended the trip may enter the album.
final class TripMembershipTests: XCTestCase {

    private let start = Date(timeIntervalSince1970: 1_000_000)

    private func makeTrip(
        startedAt: Date,
        endedAt: Date? = nil,
        homeExclusion: ActiveTrip.Geofence? = nil,
        handledWatermark: Date? = nil,
        handledAssetIds: [String] = []
    ) -> ActiveTrip {
        ActiveTrip(
            serverAlbumId: 1,
            iosAlbumId: "album-local-id",
            name: "Gardasee",
            startedAt: startedAt,
            endedAt: endedAt,
            autoAdd: true,
            mode: .sync,
            homeExclusion: homeExclusion,
            handledWatermark: handledWatermark,
            handledAssetIds: handledAssetIds,
            dismissedAssetIds: [],
            isShared: false,
            ownerUserId: nil
        )
    }

    // MARK: - Time window

    func testPhotoBeforeTripStartIsExcluded() {
        let trip = makeTrip(startedAt: start)
        XCTAssertFalse(
            TripMembership.includes(
                creationDate: start.addingTimeInterval(-1), location: nil, trip: trip
            ),
            "A photo taken before the trip started is not a trip photo"
        )
    }

    func testPhotoAtTripStartIsIncluded() {
        let trip = makeTrip(startedAt: start)
        XCTAssertTrue(
            TripMembership.includes(creationDate: start, location: nil, trip: trip)
        )
    }

    func testPhotoDuringRunningTripIsIncluded() {
        let trip = makeTrip(startedAt: start)
        XCTAssertTrue(
            TripMembership.includes(
                creationDate: start.addingTimeInterval(3600), location: nil, trip: trip
            ),
            "A running trip has an open-ended window"
        )
    }

    /// The core guarantee for the late catch-up of an ended trip.
    func testPhotoAfterTripEndIsExcluded() {
        let end = start.addingTimeInterval(7200)
        let trip = makeTrip(startedAt: start, endedAt: end)
        XCTAssertFalse(
            TripMembership.includes(
                creationDate: end.addingTimeInterval(1), location: nil, trip: trip
            ),
            "A photo taken after the trip ended must never be added to the trip album"
        )
    }

    func testPhotoBeforeTripEndIsStillIncluded() {
        let end = start.addingTimeInterval(7200)
        let trip = makeTrip(startedAt: start, endedAt: end)
        XCTAssertTrue(
            TripMembership.includes(
                creationDate: end.addingTimeInterval(-1), location: nil, trip: trip
            ),
            "Photos taken during the trip are caught up even after it ended"
        )
        XCTAssertTrue(
            TripMembership.includes(creationDate: end, location: nil, trip: trip),
            "The end instant itself is inside the window"
        )
    }

    func testAssetWithoutCreationDateIsExcluded() {
        let trip = makeTrip(startedAt: start)
        XCTAssertFalse(
            TripMembership.includes(creationDate: nil, location: nil, trip: trip),
            "An asset that can't be placed in the window is not added"
        )
    }

    // MARK: - Home exclusion

    private let munich = CLLocation(latitude: 48.14, longitude: 11.58)
    private let frankfurt = CLLocation(latitude: 50.11, longitude: 8.68)

    private func homeZone(at location: CLLocation) -> ActiveTrip.Geofence {
        ActiveTrip.Geofence(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            radiusMeters: TripMembership.homeExclusionRadiusMeters
        )
    }

    /// The regression this rule exists for: Trip Mode switched on in München,
    /// photos taken in Frankfurt. Under the old start-anchored inclusion
    /// geofence (25 km around the start) they were silently dropped and never
    /// reached the trip album.
    func testPhotoFarFromTheStartLocationIsATripPhoto() {
        let trip = makeTrip(startedAt: start, homeExclusion: homeZone(at: munich))
        XCTAssertTrue(
            TripMembership.includes(
                creationDate: start.addingTimeInterval(3600), location: frankfurt, trip: trip
            ),
            "A trip travels — distance from where it started never excludes a photo"
        )
    }

    /// The zone's actual job (`docs/ios-trip-mode.md` §5): a photo taken at
    /// home while a trip is nominally still running is not a trip photo.
    func testPhotoAtHomeIsExcluded() {
        let trip = makeTrip(startedAt: start, homeExclusion: homeZone(at: munich))
        let nextDoor = CLLocation(latitude: 48.141, longitude: 11.581)
        XCTAssertFalse(
            TripMembership.includes(
                creationDate: start.addingTimeInterval(60), location: nextDoor, trip: trip
            )
        )
    }

    func testPhotoJustOutsideTheHomeZoneIsIncluded() {
        let home = CLLocation(latitude: 48.14, longitude: 11.58)
        let trip = makeTrip(startedAt: start, homeExclusion: homeZone(at: home))
        // ~3.3 km north of home, comfortably outside the 2 km radius.
        let away = CLLocation(latitude: 48.17, longitude: 11.58)
        XCTAssertGreaterThan(away.distance(from: home), TripMembership.homeExclusionRadiusMeters)
        XCTAssertTrue(
            TripMembership.includes(
                creationDate: start.addingTimeInterval(60), location: away, trip: trip
            )
        )
    }

    /// Without a known home location the trip is a pure time window — the
    /// documented default (§2).
    func testWithoutHomeExclusionEveryWindowPhotoCounts() {
        let trip = makeTrip(startedAt: start)
        XCTAssertTrue(
            TripMembership.includes(
                creationDate: start.addingTimeInterval(60), location: munich, trip: trip
            )
        )
    }

    /// Etappe-1-Entscheidung (`docs/ios-trip-mode.md` §14.4): im Zweifel aufnehmen.
    func testPhotoWithoutGPSIsIncluded() {
        let trip = makeTrip(startedAt: start, homeExclusion: homeZone(at: munich))
        XCTAssertTrue(
            TripMembership.includes(
                creationDate: start.addingTimeInterval(60), location: nil, trip: trip
            ),
            "Assets without GPS are included even under a home exclusion zone"
        )
    }

    // MARK: - Grace period for ended trips

    func testRunningTripNeverExpires() {
        let trip = makeTrip(startedAt: start)
        XCTAssertFalse(
            TripMembership.isExpired(trip, now: start.addingTimeInterval(365 * 24 * 3600))
        )
    }

    func testEndedTripStaysPendingDuringGracePeriod() {
        let end = start.addingTimeInterval(7200)
        let trip = makeTrip(startedAt: start, endedAt: end)
        XCTAssertFalse(
            TripMembership.isExpired(trip, now: end.addingTimeInterval(3600)),
            "An hour after the end the catch-up pass still processes the trip"
        )
    }

    func testEndedTripExpiresAfterGracePeriod() {
        let end = start.addingTimeInterval(7200)
        let trip = makeTrip(startedAt: start, endedAt: end)
        XCTAssertTrue(
            TripMembership.isExpired(
                trip, now: end.addingTimeInterval(TripMembership.closedTripGrace + 1)
            ),
            "Once the grace period is over the ended trip is dropped from the pending list"
        )
    }

    // MARK: - High-water mark

    func testFirstPassSetsWatermarkAndEdge() {
        let trip = makeTrip(startedAt: start)
        let mark = start.addingTimeInterval(600)

        let advanced = TripMembership.advanced(trip, watermark: mark, edge: ["a", "b"])

        XCTAssertEqual(advanced.handledWatermark, mark)
        XCTAssertEqual(advanced.handledAssetIds, ["a", "b"])
    }

    /// The point of the watermark: the edge list must not grow with the trip.
    func testAdvancingWatermarkReplacesTheEdgeList() {
        let old = start.addingTimeInterval(600)
        let trip = makeTrip(
            startedAt: start, handledWatermark: old, handledAssetIds: ["a", "b"]
        )

        let advanced = TripMembership.advanced(
            trip, watermark: old.addingTimeInterval(60), edge: ["c"]
        )

        XCTAssertEqual(
            advanced.handledAssetIds, ["c"],
            "Assets below the new watermark are covered by the watermark itself"
        )
    }

    /// A burst shares one `creationDate`, so a shot that only reaches the
    /// library after the pass must still be remembered at the boundary.
    func testUnchangedWatermarkMergesTheEdgeList() {
        let mark = start.addingTimeInterval(600)
        let trip = makeTrip(
            startedAt: start, handledWatermark: mark, handledAssetIds: ["a", "b"]
        )

        let advanced = TripMembership.advanced(trip, watermark: mark, edge: ["b", "c"])

        XCTAssertEqual(
            advanced.handledAssetIds, ["a", "b", "c"],
            "Edge lists at the same instant merge, de-duplicated and order-stable"
        )
    }

    func testOlderWatermarkIsIgnored() {
        let mark = start.addingTimeInterval(600)
        let trip = makeTrip(
            startedAt: start, handledWatermark: mark, handledAssetIds: ["a"]
        )

        let advanced = TripMembership.advanced(
            trip, watermark: mark.addingTimeInterval(-60), edge: ["stale"]
        )

        XCTAssertEqual(advanced, trip, "A stale pass result never rewinds the watermark")
    }

    /// Trips persisted before the watermark existed decode with `nil` and are
    /// compacted by the next pass instead of needing a migration.
    func testTripWithoutWatermarkDecodesAndCompacts() throws {
        let legacy = """
        {"serverAlbumId":1,"iosAlbumId":"album-local-id","name":"Gardasee",
         "startedAt":0,"autoAdd":true,"mode":"sync",
         "handledAssetIds":["a","b","c"],"dismissedAssetIds":[],"isShared":false}
        """
        let decoded = try JSONDecoder().decode(ActiveTrip.self, from: Data(legacy.utf8))
        XCTAssertNil(decoded.handledWatermark)
        XCTAssertEqual(decoded.handledAssetIds, ["a", "b", "c"])

        let advanced = TripMembership.advanced(
            decoded, watermark: Date(timeIntervalSinceReferenceDate: 500), edge: ["d"]
        )
        XCTAssertEqual(
            advanced.handledAssetIds, ["d"],
            "The first pass after the upgrade collapses the accumulated list"
        )
    }

    // MARK: - Start-geofence migration

    /// A trip persisted while the start-anchored geofence was still in force.
    /// `handledWatermark` sits at 500 (seconds since the reference date), i.e.
    /// the pass had already examined — and discarded — everything up to there.
    private func legacyTripJSON(geofence: Bool) -> Data {
        let fence = geofence
            ? #""geofence":{"latitude":48.14,"longitude":11.58,"radiusMeters":25000},"#
            : ""
        return Data("""
        {"serverAlbumId":1,"iosAlbumId":"album-local-id","name":"München",
         "startedAt":0,"autoAdd":true,"mode":"sync",\(fence)
         "handledWatermark":500,"handledAssetIds":["a","b"],
         "dismissedAssetIds":[],"isShared":false}
        """.utf8)
    }

    /// Without the watermark reset the fix would be cosmetic: the photos the old
    /// rule rejected sit below the watermark and are never enumerated again.
    func testLegacyGeofenceTripResetsItsWatermark() throws {
        let trip = try XCTUnwrap(TripPreferences.decodeActiveTrip(legacyTripJSON(geofence: true)))

        XCTAssertNil(
            trip.handledWatermark,
            "A trip that ran under the start geofence re-scans its window from startedAt"
        )
        XCTAssertNil(trip.homeExclusion, "The legacy start geofence is not carried over")
        XCTAssertEqual(
            trip.handledAssetIds, ["a", "b"],
            "The edge list survives, so the assets it names are still skipped"
        )
    }

    /// The re-scan is a targeted repair, not a blanket one: a trip that never
    /// had a geofence was never filtered by location, so its watermark stands
    /// and nothing the user sorted out comes back.
    func testTripWithoutLegacyGeofenceKeepsItsWatermark() throws {
        let trip = try XCTUnwrap(TripPreferences.decodeActiveTrip(legacyTripJSON(geofence: false)))

        XCTAssertEqual(trip.handledWatermark, Date(timeIntervalSinceReferenceDate: 500))
        XCTAssertNil(trip.homeExclusion)
    }

    /// Ended trips are still inside their catch-up grace period, so repairing
    /// them is what actually recovers the photos of a trip the user just ended.
    func testClosedTripsAreMigratedIndividually() {
        let withFence = String(decoding: legacyTripJSON(geofence: true), as: UTF8.self)
        let withoutFence = String(decoding: legacyTripJSON(geofence: false), as: UTF8.self)
        let data = Data("[\(withFence),\(withoutFence)]".utf8)

        let trips = TripPreferences.decodeClosedTrips(data)

        XCTAssertEqual(trips.count, 2)
        XCTAssertNil(trips[0].handledWatermark, "The geofenced trip re-scans")
        XCTAssertEqual(
            trips[1].handledWatermark, Date(timeIntervalSinceReferenceDate: 500),
            "Its neighbour in the same list is untouched"
        )
    }

    /// A trip written by the current version round-trips unchanged — the
    /// migration must not fire on the new field.
    func testCurrentTripRoundTripsWithoutMigration() throws {
        let home = ActiveTrip.Geofence(latitude: 48.14, longitude: 11.58, radiusMeters: 2_000)
        let trip = makeTrip(
            startedAt: start,
            homeExclusion: home,
            handledWatermark: start.addingTimeInterval(600),
            handledAssetIds: ["a"]
        )

        let data = try JSONEncoder().encode(trip)
        let decoded = try XCTUnwrap(TripPreferences.decodeActiveTrip(data))

        XCTAssertEqual(decoded, trip)
    }
}
