import XCTest
@testable import FKPhotosLib

/// The pool on a map (§5.2).
///
/// Two questions decide whether the second shape of the pool is honest.
/// One: does it show the same pool the list shows — a search that
/// narrows the rows and leaves the pins is a map answering a question
/// nobody asked. Two: does a pin say only what a candidate is, without
/// borrowing a day's number, block or way there.
final class TripPoolMapTests: XCTestCase {

    private func candidate(
        _ ref: String,
        name: String? = "Spot",
        category: String = "sight",
        score: Double = 1,
        origin: String = "search",
        note: String? = nil,
        photoStop: Bool? = nil,
        title: String? = nil,
        localName: String? = nil,
        wikipediaUrl: String? = nil,
        sourceUrl: String? = nil,
    ) -> TripCandidate {
        TripCandidate(
            osmRef: ref,
            name: name,
            lat: 48.37,
            lon: 10.9,
            category: category,
            dwellMinutes: 60,
            score: score,
            reasons: [],
            origin: origin,
            note: note,
            sourceUrl: sourceUrl,
            unmatched: nil,
            title: title,
            localName: localName,
            wikipediaUrl: wikipediaUrl,
            photoStop: photoStop,
        )
    }

    private func leg(pool: [TripCandidate], planned: [String] = []) -> TripLeg {
        let stops = planned.enumerated().map { index, ref in
            TripStop(
                rowId: index + 1, osmRef: ref, name: "Geplant", lat: 48.0, lon: 10.0,
                category: "sight", dwellMinutes: 60,
                travelFromPrevious: TripTravel(minutes: 0, distanceM: 0, travelClass: "short_walk"),
                status: "planned", pinned: false, note: nil, sourceUrl: nil,
                title: nil, localName: nil, wikipediaUrl: nil, photoStop: nil,
            )
        }
        let block = TripBlock(id: "morning", rowId: 1, label: "Vormittag", kind: "spots",
                              budgetMinutes: 180, usedMinutes: 0, startMinutes: 9 * 60,
                              stops: stops, branches: nil)
        let day = TripDay(id: 1, dayIndex: 0, detailed: true, bufferReason: nil,
                          blocks: [block], fixpoints: [])
        return TripLeg(
            id: 1, position: 0, title: "Lissabon",
            anchor: TripCoordinate(lat: 48.0, lon: 10.0), anchorRadiusM: nil,
            anchorLabel: "Hotel Beispielhof", arriveMinutes: nil, mode: "foot",
            regionDb: "region", awaitingRegion: nil, startDate: nil,
            days: [day], pool: pool,
        )
    }

    // MARK: - One filter for both shapes

    func testTheBestScoredComeFirstAndTiesGoByName() {
        let pool = [candidate("node:1", name: "Zoo", score: 2),
                    candidate("node:2", name: "Aquarium", score: 2),
                    candidate("node:3", name: "Burg", score: 9)]
        XCTAssertEqual(TripPoolFilter.matches(in: pool, query: "").map(\.displayName),
                       ["Burg", "Aquarium", "Zoo"])
    }

    func testTheSearchReadsTheNoteToo() {
        // "Beste Pastéis laut Blog" is often the only part of a find
        // anybody recalls (§9.2).
        let pool = [candidate("node:1", name: "Café Beispiel", note: "beste Pastéis laut Blog"),
                    candidate("node:2", name: "Burg")]
        XCTAssertEqual(TripPoolFilter.matches(in: pool, query: "pastéis").map(\.osmRef),
                       ["node:1"])
    }

    func testTheSearchReadsTheCategoryAndIgnoresCaseAndPadding() {
        let pool = [candidate("node:1", name: "Beispielhaus", category: "museum"),
                    candidate("node:2", name: "Burg", category: "castle")]
        XCTAssertEqual(TripPoolFilter.matches(in: pool, query: "  MUSEUM ").map(\.osmRef),
                       ["node:1"])
    }

    func testAnEmptySearchIsNoSearchRatherThanNoResults() {
        let pool = [candidate("node:1"), candidate("node:2")]
        XCTAssertEqual(TripPoolFilter.matches(in: pool, query: "   ").count, 2)
    }

    func testTheCountSaysHowMuchOfThePoolIsOnScreen() {
        XCTAssertEqual(TripPoolFilter.countLabel(shown: 1, of: 1), "1 Kandidat")
        XCTAssertEqual(TripPoolFilter.countLabel(shown: 12, of: 12), "12 Kandidaten")
        XCTAssertEqual(TripPoolFilter.countLabel(shown: 3, of: 12), "3 von 12")
    }

    func testWhatIsOnADayIsKnownByItsReference() {
        let subject = leg(pool: [candidate("node:1")], planned: ["node:7"])
        XCTAssertEqual(TripPoolFilter.plannedRefs(of: subject), ["node:7"])
    }

    // MARK: - What the colour of a pin says

    func testAlreadyOnADayBeatsEverythingElseAPinCouldSay() {
        // It answers the question somebody scanning the map is actually
        // asking: what is still to be had.
        let own = candidate("node:1", origin: "manual", photoStop: true)
        XCTAssertEqual(TripPoolPinKind.of(own, plannedRefs: ["node:1"]), .planned)
    }

    func testAnOwnFindIsItsOwnColourBeforeItIsAPhotoStop() {
        let own = candidate("node:1", origin: "manual", photoStop: true)
        XCTAssertEqual(TripPoolPinKind.of(own, plannedRefs: []), .ownFind)
    }

    func testAPhotoStopSaysSoAndAnythingElseIsSimplyACandidate() {
        XCTAssertEqual(TripPoolPinKind.of(candidate("node:1", photoStop: true), plannedRefs: []),
                       .photoStop)
        XCTAssertEqual(TripPoolPinKind.of(candidate("node:2"), plannedRefs: []), .candidate)
    }

    func testTheLegendNamesEveryKindOnceWithWhatMostPinsAreFirst() {
        XCTAssertEqual(TripPoolPinKind.legendOrder,
                       [.candidate, .ownFind, .photoStop, .planned])
        XCTAssertEqual(Set(TripPoolPinKind.legendOrder), Set(TripPoolPinKind.allCases))
        XCTAssertEqual(TripPoolPinKind.legendOrder.map(\.label),
                       ["Kandidat", "eigener Fund", "Fotostopp", "schon eingeplant"])
    }

    // MARK: - What a pin out of the pool may say

    func testACandidateCarriesThePlaceAndNoPlan() {
        // No number, because the pool has no order; no block, because it
        // is on no day; no way there, because there is no stop before it.
        let detail = TripPinDetail.of(candidate("node:1", name: "Aussicht", note: "  früh hin  ",
                                                photoStop: true))
        XCTAssertNil(detail.planned)
        XCTAssertEqual(detail.osmRef, "node:1")
        XCTAssertEqual(detail.title, "Aussicht")
        XCTAssertEqual(detail.note, "früh hin")
        XCTAssertTrue(detail.isPhotoStop)
        XCTAssertEqual(detail.coordinate.lat, 48.37)
    }

    func testTheSignIsKeptBesideTheNameAndDroppedWhenItIsTheNameAlready() {
        let named = TripPinDetail.of(candidate("node:1", name: "Miradouro",
                                               title: "Der Blick über die Stadt",
                                               localName: "Miradouro"))
        XCTAssertEqual(named.title, "Der Blick über die Stadt")
        XCTAssertEqual(named.localName, "Miradouro")

        let same = TripPinDetail.of(candidate("node:2", name: "Miradouro", localName: "Miradouro"))
        XCTAssertNil(same.localName)
    }

    func testAnUnnamedCandidateSaysWhatItIsRatherThanInventingAName() {
        let detail = TripPinDetail.of(candidate("node:1", name: nil, category: "viewpoint"))
        XCTAssertEqual(detail.title, "Aussichtspunkt, ohne Namen")
        XCTAssertEqual(detail.category, "Aussichtspunkt")
    }

    func testAnEmptyNoteIsNoNoteAndABrokenLinkIsSimplyAbsent() {
        let detail = TripPinDetail.of(candidate("node:1", note: "   ",
                                                sourceUrl: "not a url at all"))
        XCTAssertNil(detail.note)
        XCTAssertNil(detail.sourceUrl?.host)
    }

    func testTheMapLinkWorksForACandidateToo() {
        let detail = TripPinDetail.of(candidate("node:1", name: "Aussicht"))
        let place = TripMapLink.place(from: TripPinDetail.mapsURL(for: detail))
        XCTAssertEqual(place?.lat, 48.37)
        XCTAssertEqual(place?.lon, 10.9)
    }

    // MARK: - The switch between the two shapes

    func testTheRememberedShapeSurvivesAsAName() {
        // Stored in @AppStorage: a raw value tied to the order of the
        // cases would turn "map" into "list" the next time somebody
        // adds one.
        XCTAssertEqual(TripPoolPresentation.list.rawValue, "list")
        XCTAssertEqual(TripPoolPresentation.map.rawValue, "map")
        XCTAssertEqual(TripPoolPresentation.allCases.map(\.label), ["Liste", "Karte"])
    }
}
