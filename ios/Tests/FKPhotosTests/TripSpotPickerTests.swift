import XCTest
@testable import FKPhotosLib

/// The spot picker (reise-planen-und-unterwegs.md, stage 4).
final class TripSpotPickerTests: XCTestCase {
    private func idea(_ n: Int, name: String) -> TripCandidate {
        let json = """
        {"osmRef":"node:\(n)","name":"\(name)","lat":48.37,"lon":10.9,"category":"museum",
         "dwellMinutes":60,"score":10,"reasons":[],"origin":"manual"}
        """
        return try! JSONDecoder().decode(TripCandidate.self, from: Data(json.utf8))
    }

    private func highlight(_ n: Int, inPool: Bool = false) -> TripHighlight {
        let json = """
        {"osmRef":"node:\(n)","name":"Beispielplatz \(n)","lat":48.37,"lon":10.9,"category":"sight",
         "distanceM":400,"dwellMinutes":45,"openingHours":"Fr 10:00-18:00","inPool":\(inPool),"planned":false}
        """
        return try! JSONDecoder().decode(TripHighlight.self, from: Data(json.utf8))
    }

    private func found(_ n: Int) -> TripSearchedPlace {
        TripSearchedPlace(osmRef: "node:\(n)", name: "Beispielmarkt \(n)", lat: 48.37, lon: 10.9, distanceM: 200,
                          categories: ["market"], legIndex: 0, openingHours: nil, phone: nil, website: nil,
                          dwellMinutes: 30, inPool: false, planned: false)
    }

    func testWithoutAQueryTheIdeasComeFirstThenTheHighlightsOnce() {
        let items = TripSpotPicker.items(
            chip: .all, query: "",
            ideas: [idea(1, name: "Beispielturm")],
            highlights: [highlight(1, inPool: true), highlight(2), highlight(3)],
            results: [],
        )
        XCTAssertEqual(items.map(\.osmRef), ["node:1", "node:2", "node:3"])
        XCTAssertTrue(items[0].isIdea)
        // The rank is the place among the highlights, for the map's circles.
        XCTAssertEqual(items[1].rank, 1)
        XCTAssertEqual(items[1].openingHours, "Fr 10:00-18:00")
    }

    func testAQueryListsMatchingIdeasThenTheSearch() {
        let items = TripSpotPicker.items(
            chip: .all, query: "turm",
            ideas: [idea(1, name: "Beispielturm"), idea(2, name: "Beispielbrunnen")],
            highlights: [highlight(5)],
            results: [found(7)],
        )
        XCTAssertEqual(items.map(\.osmRef), ["node:1", "node:7"])
        XCTAssertEqual(TripSpotPicker.items(chip: .ideas, query: "", ideas: [idea(1, name: "A")],
                                            highlights: [highlight(5)], results: []).map(\.osmRef),
                       ["node:1"])
    }

    func testAPastedMapLinkIsOneRow() throws {
        let place = try XCTUnwrap(TripSpotPicker.linkPlace(
            "https://maps.apple.com/?ll=48.37,10.9&q=Beispielort", legIndex: 2))
        XCTAssertEqual(place.name, "Beispielort")
        XCTAssertEqual(place.legIndex, 2)
        XCTAssertNil(TripSpotPicker.linkPlace("Beispielort", legIndex: 0))
        let items = TripSpotPicker.items(chip: .all, query: "https://maps.apple.com/?ll=48.37,10.9",
                                         ideas: [idea(1, name: "A")], highlights: [], results: [],
                                         link: place)
        XCTAssertEqual(items.count, 1)
        XCTAssertTrue(items[0].osmRef.hasPrefix("link:"))
    }

    func testTheButtonTellsVoiceOverTheSuggestedDay() {
        XCTAssertEqual(TripSpotPicker.addLabel(nil), "Hinzufügen")
        XCTAssertEqual(TripSpotPicker.addLabel(
            TripDaySuggestion(osmRef: "x", dayIndex: 1, blockId: "b", full: false)), "Auf Tag 2 legen")
        XCTAssertEqual(TripSpotPicker.addLabel(
            TripDaySuggestion(osmRef: "x", dayIndex: nil, blockId: nil, full: false)), "Hinzufügen")
    }

    func testOnAJourneyTheButtonSaysOnTheWayNotADay() {
        XCTAssertEqual(TripSpotPicker.addLabel(
            TripDaySuggestion(osmRef: "x", dayIndex: 0, blockId: "transit", full: false), onTheWay: true),
            "Unterwegs einplanen")
        XCTAssertEqual(TripSpotPicker.addLabel(nil, onTheWay: true), "Hinzufügen")
    }

    func testTheSearchRadiusIsHalfTheVisibleMap() {
        let radius = TripSpotPicker.radiusM(latitudeDelta: 0.02, longitudeDelta: 0.02, latitude: 0)
        XCTAssertEqual(radius, 1_110, accuracy: 1)
        XCTAssertEqual(TripSpotPicker.markerSize(rank: 0), 34)
        XCTAssertEqual(TripSpotPicker.markerSize(rank: 20), 18)
    }
}
