import XCTest
@testable import FKPhotosLib

/// Searching for a place, and what reaches the pool from a result
/// (§9.2, case 4).
///
/// The decision worth guarding is whether a duration is sent. A place
/// whose category the planner knows has a default on the server;
/// sending one anyway would override real data with a guess. A place
/// with no such category has nothing to fall back on, and leaving the
/// field out would make the server refuse.
@MainActor
final class TripPlaceSearchViewModelTests: XCTestCase {
    private func place(
        osmRef: String = "node:1",
        dwellMinutes: Int? = 60,
        distanceM: Double? = 400,
        legIndex: Int = 1,
    ) -> TripSearchedPlace {
        TripSearchedPlace(
            osmRef: osmRef,
            name: "Stadtmuseum Beispielstadt",
            lat: 48.37,
            lon: 10.9,
            distanceM: distanceM,
            categories: ["museum"],
            legIndex: legIndex,
            openingHours: "Tu-Su 10:00-17:00",
            phone: nil,
            website: nil,
            dwellMinutes: dwellMinutes,
            inPool: false,
            planned: false,
        )
    }

    func testAKnownCategoryKeepsTheServersOwnDuration() {
        let vm = TripPlaceSearchViewModel(planId: 1)
        let request = vm.requestFor(place(dwellMinutes: 60))
        XCTAssertNil(request.dwellMinutes)
        XCTAssertEqual(request.legIndex, 1)
        XCTAssertEqual(request.lat, 48.37)
    }

    func testAPlaceWithNoDefaultGetsOneToStartFrom() {
        // Without this the server refuses, because §9.2 will not let it
        // invent a duration.
        let vm = TripPlaceSearchViewModel(planId: 1)
        let request = vm.requestFor(place(dwellMinutes: nil))
        XCTAssertEqual(request.dwellMinutes, TripPlaceSearchViewModel.fallbackDwellMinutes)
    }

    func testASearchResultCarriesNoInventedReason() {
        // "Warum hier?" is where a real reason belongs. Nobody wrote one
        // for a search result, and "gefunden über die Suche" would fill
        // the field with nothing.
        let vm = TripPlaceSearchViewModel(planId: 1)
        let request = vm.requestFor(place())
        XCTAssertNil(request.note)
        XCTAssertNil(request.sourceUrl)
    }

    func testNothingIsSearchedForOneCharacter() async {
        let vm = TripPlaceSearchViewModel(planId: 1)
        vm.query = "a"
        await vm.search()
        // Never ran, so the list must not claim to have found nothing.
        XCTAssertFalse(vm.hasSearched)
    }
}

final class TripSearchedPlaceTests: XCTestCase {
    private func withDistance(_ distanceM: Double?) -> TripSearchedPlace {
        TripSearchedPlace(
            osmRef: "node:1", name: "Beispiel", lat: 0, lon: 0, distanceM: distanceM,
            categories: [], legIndex: 0, openingHours: nil, phone: nil, website: nil,
            dwellMinutes: nil, inPool: false, planned: false,
        )
    }

    func testDistancesReadTheWayGermanWritesThem() {
        XCTAssertEqual(withDistance(300).distanceLabel, "300 m")
        XCTAssertEqual(withDistance(4_200).distanceLabel, "4,2 km")
        XCTAssertEqual(withDistance(999).distanceLabel, "999 m")
        XCTAssertEqual(withDistance(1_000).distanceLabel, "1,0 km")
    }

    func testAnUnknownDistanceHasNoLabelRatherThanAZero() {
        XCTAssertNil(withDistance(nil).distanceLabel)
    }
}
