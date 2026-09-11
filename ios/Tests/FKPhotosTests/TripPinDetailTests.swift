import XCTest
@testable import FKPhotosLib

/// What a tapped pin on the day map may say (§8.3).
///
/// The interesting half is what it must *not* say. A pin is a place and
/// a position in a walking order, not an appointment: the plan knows
/// the block's hours and the dwell time, never the clock time of the
/// stop itself (§4.1). Most of these tests guard that line.
final class TripPinDetailTests: XCTestCase {

    private func stop(
        _ id: Int,
        name: String? = "Spot",
        title: String? = nil,
        localName: String? = nil,
        category: String = "sight",
        dwell: Int = 60,
        travel: Int = 0,
        travelClass: String = "short_walk",
        status: String = "planned",
        pinned: Bool = false,
        note: String? = nil,
        sourceUrl: String? = nil,
        wikipediaUrl: String? = nil,
        photoStop: Bool? = nil,
    ) -> TripStop {
        TripStop(
            rowId: id,
            osmRef: "node:\(id)",
            name: name,
            lat: 50.0,
            lon: 8.0,
            category: category,
            dwellMinutes: dwell,
            travelFromPrevious: TripTravel(minutes: travel, distanceM: travel * 75, travelClass: travelClass),
            status: status,
            pinned: pinned,
            note: note,
            sourceUrl: sourceUrl,
            title: title,
            localName: localName,
            wikipediaUrl: wikipediaUrl,
            photoStop: photoStop,
        )
    }

    private func day(_ stops: [TripStop], start: Int? = 9 * 60, budget: Int = 180) -> TripDay {
        let block = TripBlock(
            id: "morning",
            rowId: 1,
            label: "Vormittag",
            kind: "spots",
            budgetMinutes: budget,
            usedMinutes: stops.reduce(0) { $0 + $1.dwellMinutes },
            startMinutes: start,
            stops: stops,
            branches: nil,
        )
        return TripDay(id: 1, dayIndex: 0, detailed: true, bufferReason: nil,
                       blocks: [block], fixpoints: [])
    }

    // MARK: - What it says about time

    func testItNamesTheBlockAndTheDwellTimeButNeverAnHourForTheStop() {
        let spot = stop(1, dwell: 90)
        let detail = TripPinDetail.of(spot, number: 3, in: day([stop(9, dwell: 30), spot]))

        XCTAssertEqual(detail.blockText, "Vormittag · 09:00 – 12:00")
        XCTAssertEqual(detail.dwellText, "etwa 1 h 30 vor Ort")
        // The plan never computed "you are there at 10:20"; the sheet
        // must not be the first place that number appears.
        XCTAssertFalse(detail.dwellText.contains("10:"))
    }

    func testADayWithoutHoursKeepsTheBlockNameAndNothingElse() {
        // Plans written before block times were kept. "Vormittag" is
        // true; "Vormittag · 00:00 – 03:00" would not be.
        let spot = stop(1)
        let detail = TripPinDetail.of(spot, number: 1, in: day([spot], start: nil))
        XCTAssertEqual(detail.blockText, "Vormittag")
    }

    func testAStopNoBlockClaimsHasNoBlockLine() {
        let detail = TripPinDetail.of(stop(42), number: 1, in: day([stop(1)]))
        XCTAssertNil(detail.blockText)
    }

    // MARK: - The way there

    func testTheWalkThereIsMinutesAndDistance() {
        let spot = stop(1, travel: 12)
        let detail = TripPinDetail.of(spot, number: 2, in: day([stop(9), spot]))
        XCTAssertEqual(detail.travelText, "12 min zu Fuß · 900 m")
    }

    func testARideSaysSoInsteadOfWalking() {
        let spot = stop(1, travel: 20, travelClass: "transit")
        let detail = TripPinDetail.of(spot, number: 2, in: day([spot]))
        XCTAssertEqual(detail.travelText, "20 min mit Bus oder Bahn · 1,5 km")
    }

    func testNoTravelAtAllIsSilenceRatherThanZeroMinutes() {
        // The first stop of a block, or one next door. "0 min zu Fuß"
        // is a line that says nothing at length.
        let detail = TripPinDetail.of(stop(1, travel: 0), number: 1, in: day([stop(1, travel: 0)]))
        XCTAssertNil(detail.travelText)
    }

    // MARK: - What it calls the place

    func testTheGroupsOwnNameWinsAndTheSignIsKeptBeside() {
        let spot = stop(1, name: "Kaiserbrunnen", title: "Der Brunnen mit den Fischen",
                        localName: "Kaiserbrunnen")
        let detail = TripPinDetail.of(spot, number: 1, in: day([spot]))
        XCTAssertEqual(detail.title, "Der Brunnen mit den Fischen")
        XCTAssertEqual(detail.localName, "Kaiserbrunnen")
    }

    func testTheSignIsDroppedWhenItIsTheNameAlready() {
        let spot = stop(1, name: "Kaiserbrunnen", localName: "Kaiserbrunnen")
        let detail = TripPinDetail.of(spot, number: 1, in: day([spot]))
        XCTAssertNil(detail.localName)
    }

    func testAnUnnamedPlaceSaysWhatItIsRatherThanInventingAName() {
        let spot = stop(1, name: nil, category: "viewpoint")
        let detail = TripPinDetail.of(spot, number: 1, in: day([spot]))
        XCTAssertEqual(detail.title, "Aussichtspunkt, ohne Namen")
        XCTAssertEqual(detail.category, "Aussichtspunkt")
    }

    // MARK: - Marks and notes

    func testAnEmptyNoteIsNoNote() {
        let spot = stop(1, note: "   ")
        XCTAssertNil(TripPinDetail.of(spot, number: 1, in: day([spot])).note)
    }

    func testTheMarksAreCarriedThrough() {
        let spot = stop(1, status: "done", pinned: true, note: "Papa wollte da hin",
                        photoStop: true)
        let detail = TripPinDetail.of(spot, number: 1, in: day([spot]))
        XCTAssertEqual(detail.status, .done)
        XCTAssertEqual(detail.statusLabel, "Erledigt")
        XCTAssertTrue(detail.isPinned)
        XCTAssertTrue(detail.isPhotoStop)
        XCTAssertEqual(detail.note, "Papa wollte da hin")
    }

    func testALinkThatIsNoUrlIsSimplyAbsent() {
        let spot = stop(1, sourceUrl: "not a url at all", wikipediaUrl: "https://de.wikipedia.org/wiki/Brunnen")
        let detail = TripPinDetail.of(spot, number: 1, in: day([spot]))
        XCTAssertEqual(detail.wikipediaUrl?.absoluteString, "https://de.wikipedia.org/wiki/Brunnen")
        XCTAssertNil(detail.sourceUrl?.host)
    }

    // MARK: - Handing the place to Apple Maps

    func testTheMapLinkCarriesTheCoordinateNotASearch() {
        let spot = stop(1, name: nil, category: "viewpoint")
        let url = TripPinDetail.mapsURL(for: TripPinDetail.of(spot, number: 1, in: day([spot])))
        let place = TripMapLink.place(from: url)
        XCTAssertEqual(place?.lat, 50.0)
        XCTAssertEqual(place?.lon, 8.0)
        // Searching for "Aussichtspunkt, ohne Namen" would find a
        // different bench every time; the name is only the label.
        XCTAssertTrue(url.absoluteString.contains("ll=50.000000,8.000000"))
    }

    // MARK: - The legend

    func testTheLegendNamesEveryStateOnce() {
        XCTAssertEqual(TripStopStatus.legendOrder, [.planned, .done, .skipped])
        XCTAssertEqual(TripStopStatus.legendOrder.map(\.label),
                       ["Geplant", "Erledigt", "Ausgelassen"])
    }

    // MARK: - Distances, in one place

    func testDistancesReadAsAWalkAboveAKilometre() {
        XCTAssertEqual(TripDistance.text(999), "999 m")
        XCTAssertEqual(TripDistance.text(1000), "1,0 km")
        XCTAssertEqual(TripDistance.text(1437), "1,4 km")
    }
}
