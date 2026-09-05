import XCTest
@testable import FKPhotosLib

/// Handing a stop or a block over to a map app (§9.1).
///
/// The URLs are pure so they can be checked here rather than by opening
/// them and looking: the wrong travel mode is not something a screenshot
/// catches, and it silently invalidates the arrival time the whole plan
/// reckons with.
final class TripMapsHandoffTests: XCTestCase {

    /// An invented route through an invented town.
    private let a = TripCoordinate(lat: 48.370100, lon: 10.897800)
    private let b = TripCoordinate(lat: 48.372500, lon: 10.900200)
    private let c = TripCoordinate(lat: 48.375000, lon: 10.903000)

    // MARK: - Travel mode must survive the handoff

    func testAppleModeFollowsTheLeg() {
        XCTAssertEqual(TripRouteMode(.foot).appleDirectionsMode, "MKLaunchOptionsDirectionsModeWalking")
        XCTAssertEqual(TripRouteMode(.transit).appleDirectionsMode, "MKLaunchOptionsDirectionsModeTransit")
        XCTAssertEqual(TripRouteMode(.car).appleDirectionsMode, "MKLaunchOptionsDirectionsModeDriving")
    }

    func testCyclingFallsBackToWalkingNotDriving() {
        // Apple Maps has no cycling mode. Driving would hand back an
        // arrival time the block never budgeted for; walking is too slow
        // rather than too fast, so the block still holds.
        XCTAssertEqual(TripRouteMode(.bike).appleDirectionsMode, "MKLaunchOptionsDirectionsModeWalking")
        // Google does know bicycling, so nothing is given up there.
        XCTAssertEqual(TripRouteMode(.bike).googleDirectionsMode, "bicycling")
    }

    func testGoogleModeFollowsTheLeg() {
        XCTAssertEqual(TripRouteMode(.foot).googleDirectionsMode, "walking")
        XCTAssertEqual(TripRouteMode(.transit).googleDirectionsMode, "transit")
        XCTAssertEqual(TripRouteMode(.car).googleDirectionsMode, "driving")
    }

    // MARK: - URLs

    func testGoogleAppURLCarriesDestinationAndMode() throws {
        let url = try XCTUnwrap(TripMapsURL.googleApp(to: b, mode: .transit))
        let string = url.absoluteString
        XCTAssertTrue(string.hasPrefix("comgooglemaps:"), string)
        XCTAssertTrue(string.contains("daddr=48.372500,10.900200"), string)
        XCTAssertTrue(string.contains("directionsmode=transit"), string)
    }

    func testUniversalURLTakesAWholeBlockAsOneRoute() throws {
        // The morning travels over at once: the last stop is the
        // destination, everything before it a waypoint (§9.1).
        let url = try XCTUnwrap(
            TripMapsURL.googleUniversal(through: [a, b, c], from: a, mode: .walking),
        )
        let string = url.absoluteString
        XCTAssertTrue(string.contains("destination=48.375000,10.903000"), string)
        XCTAssertTrue(string.contains("origin=48.370100,10.897800"), string)
        XCTAssertTrue(string.contains("travelmode=walking"), string)
        // Waypoints are the stops between origin and destination.
        XCTAssertTrue(string.contains("waypoints="), string)
        XCTAssertTrue(string.contains("48.372500,10.900200"), string)
    }

    func testUniversalURLWithASingleStopHasNoWaypoints() throws {
        let url = try XCTUnwrap(TripMapsURL.googleUniversal(through: [b], mode: .driving))
        XCTAssertFalse(url.absoluteString.contains("waypoints="), url.absoluteString)
        XCTAssertTrue(url.absoluteString.contains("destination=48.372500,10.900200"))
    }

    func testUniversalURLRefusesAnEmptyRoute() {
        XCTAssertNil(TripMapsURL.googleUniversal(through: [], mode: .walking))
    }

    func testLookupAlwaysCarriesTheCoordinate() throws {
        // The name sharpens the match; the coordinate decides. A wrong
        // or missing name must not send the traveller elsewhere.
        let named = try XCTUnwrap(TripMapsURL.googleLookup(b, name: "Stadtmuseum Beispielstadt"))
        XCTAssertTrue(named.absoluteString.contains("48.372500,10.900200"), named.absoluteString)

        let unnamed = try XCTUnwrap(TripMapsURL.googleLookup(b, name: nil))
        XCTAssertTrue(unnamed.absoluteString.contains("48.372500,10.900200"), unnamed.absoluteString)
    }

    func testCoordinatesAreFormattedIndependentlyOfLocale() {
        // A comma decimal separator would split the pair into three
        // numbers and send the route somewhere else entirely.
        let formatted = TripMapsURL.coordinate(TripCoordinate(lat: 48.5, lon: 10.25))
        XCTAssertEqual(formatted, "48.500000,10.250000")
    }

    // MARK: - Which app, and the stumbling block

    func testGoogleAppearsOnlyWhenItIsInstalled() {
        let without = TripMapsAvailability(preference: .ask, googleAppInstalled: false)
        XCTAssertEqual(without.options, [.apple])
        // Nothing to ask about, so do not ask: a chooser with one entry
        // is a worse Apple Maps.
        XCTAssertEqual(without.resolved, .apple)

        let with = TripMapsAvailability(preference: .ask, googleAppInstalled: true)
        XCTAssertEqual(with.options, [.apple, .google])
        XCTAssertNil(with.resolved)
    }

    func testAStoredGooglePreferenceDoesNotStrandTheUser() {
        // The setting can outlive the app being uninstalled. Opening a
        // dead scheme would do nothing at all, which reads as a broken
        // button.
        let stale = TripMapsAvailability(preference: .google, googleAppInstalled: false)
        XCTAssertEqual(stale.resolved, .apple)

        let live = TripMapsAvailability(preference: .google, googleAppInstalled: true)
        XCTAssertEqual(live.resolved, .google)
    }

    func testApplePreferenceIsHonouredEitherWay() {
        for installed in [true, false] {
            let a = TripMapsAvailability(preference: .apple, googleAppInstalled: installed)
            XCTAssertEqual(a.resolved, .apple)
        }
    }

    func testTheAppsInfoPlistDeclaresTheQueryScheme() throws {
        // Without the Info.plist entry, canOpenURL answers "not
        // installed" however the device is set up, and the Google option
        // disappears with no error anywhere — the classic stumbling
        // block the concept warns about (§9.1).
        //
        // Read from disk rather than through a Bundle: in a unit-test
        // target `Bundle.main` is the test runner and the test bundle
        // has its own Info.plist, so neither can see the app's. The
        // thing being guarded is a file, so the test opens the file.
        let plist = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // FKPhotosTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // ios
            .appendingPathComponent("Sources/FKPhotos/Info.plist")

        let data = try Data(contentsOf: plist)
        let parsed = try PropertyListSerialization.propertyList(from: data, format: nil)
        let schemes = (parsed as? [String: Any])?["LSApplicationQueriesSchemes"] as? [String]

        XCTAssertEqual(
            schemes?.contains(TripMapsApp.googleScheme), true,
            "LSApplicationQueriesSchemes in \(plist.path) must list \(TripMapsApp.googleScheme)",
        )
    }


    // MARK: - The setting

    func testPreferenceDefaultsToAppleMaps() {
        let defaults = UserDefaults(suiteName: "TripMapsHandoffTests.default")!
        defaults.removePersistentDomain(forName: "TripMapsHandoffTests.default")
        XCTAssertEqual(TripMapsPreference.load(defaults), .apple)
    }

    func testPreferenceRoundTrips() {
        let defaults = UserDefaults(suiteName: "TripMapsHandoffTests.roundtrip")!
        defaults.removePersistentDomain(forName: "TripMapsHandoffTests.roundtrip")
        TripMapsPreference.save(.google, to: defaults)
        XCTAssertEqual(TripMapsPreference.load(defaults), .google)
        TripMapsPreference.save(.ask, to: defaults)
        XCTAssertEqual(TripMapsPreference.load(defaults), .ask)
    }

    func testAnUnreadableStoredValueFallsBackRatherThanCrashing() {
        let defaults = UserDefaults(suiteName: "TripMapsHandoffTests.garbage")!
        defaults.removePersistentDomain(forName: "TripMapsHandoffTests.garbage")
        defaults.set("waze", forKey: TripMapsPreference.key)
        XCTAssertEqual(TripMapsPreference.load(defaults), .apple)
    }
}
