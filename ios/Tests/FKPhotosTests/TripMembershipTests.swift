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
        geofence: ActiveTrip.Geofence? = nil
    ) -> ActiveTrip {
        ActiveTrip(
            serverAlbumId: 1,
            iosAlbumId: "album-local-id",
            name: "Gardasee",
            startedAt: startedAt,
            endedAt: endedAt,
            autoAdd: true,
            mode: .sync,
            geofence: geofence,
            handledAssetIds: [],
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

    // MARK: - Geofence

    private let gardasee = ActiveTrip.Geofence(
        latitude: 45.6, longitude: 10.7, radiusMeters: 25_000
    )

    func testGeofenceExcludesDistantPhoto() {
        let trip = makeTrip(startedAt: start, geofence: gardasee)
        let munich = CLLocation(latitude: 48.14, longitude: 11.58)
        XCTAssertFalse(
            TripMembership.includes(
                creationDate: start.addingTimeInterval(60), location: munich, trip: trip
            ),
            "A located photo outside the radius is not a trip photo"
        )
    }

    func testGeofenceIncludesNearbyPhoto() {
        let trip = makeTrip(startedAt: start, geofence: gardasee)
        let nearby = CLLocation(latitude: 45.62, longitude: 10.72)
        XCTAssertTrue(
            TripMembership.includes(
                creationDate: start.addingTimeInterval(60), location: nearby, trip: trip
            )
        )
    }

    /// Etappe-1-Entscheidung (`docs/ios-trip-mode.md` §14.4): im Zweifel aufnehmen.
    func testGeofenceIncludesPhotoWithoutGPS() {
        let trip = makeTrip(startedAt: start, geofence: gardasee)
        XCTAssertTrue(
            TripMembership.includes(
                creationDate: start.addingTimeInterval(60), location: nil, trip: trip
            ),
            "Assets without GPS are included even under a geofence"
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
}
