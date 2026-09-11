import XCTest
@testable import FKPhotosLib

/// Reading a place out of a shared map link (§9.2, way 1).
///
/// The commonest way anything reaches this app, and the one where a
/// silent misreading is worst: a coordinate that parses wrongly puts an
/// entry in the collection that looks right and is somewhere else.
final class TripMapLinkTests: XCTestCase {

    func testAShareUrlYieldsCoordinateAndName() {
        let place = TripMapLink.place(
            from: "https://maps.apple.com/?ll=48.3705,10.8978&q=Goldener+Saal&t=m",
        )
        XCTAssertEqual(place?.lat ?? 0, 48.3705, accuracy: 0.00001)
        XCTAssertEqual(place?.lon ?? 0, 10.8978, accuracy: 0.00001)
        XCTAssertEqual(place?.name, "Goldener Saal")
    }

    func testAPlaceUrlWithExtraParametersStillReads() {
        let place = TripMapLink.place(
            from: "https://maps.apple.com/place?auid=123&ll=47.2,11.4&q=Burg",
        )
        XCTAssertEqual(place?.lat ?? 0, 47.2, accuracy: 0.00001)
        XCTAssertEqual(place?.name, "Burg")
    }

    func testTheMapsSchemeIsReadInEveryShapeSendersUse() {
        // `maps:` is an opaque URL: without a question mark everything
        // sits in the path, where a query parser never looks. All three
        // shapes turn up, and all three name the same place.
        for link in ["maps:q=Ort&ll=50.1,8.7",
                     "maps:?q=Ort&ll=50.1,8.7",
                     "maps://?q=Ort&ll=50.1,8.7"] {
            let place = TripMapLink.place(from: link)
            XCTAssertEqual(place?.lat ?? 0, 50.1, accuracy: 0.00001, link)
            XCTAssertEqual(place?.lon ?? 0, 8.7, accuracy: 0.00001, link)
            XCTAssertEqual(place?.name, "Ort", link)
        }
    }

    func testALinkWithoutANameIsStillAPlace() {
        // The coordinate is what makes it findable; the name is a
        // convenience. Refusing the link for want of one would throw
        // away the half that matters.
        let place = TripMapLink.place(from: "https://maps.apple.com/?ll=48.0,11.0")
        XCTAssertNotNil(place)
        XCTAssertNil(place?.name)
    }

    func testAnEmptyNameIsNoName() {
        let place = TripMapLink.place(from: "https://maps.apple.com/?ll=48.0,11.0&q=")
        XCTAssertNotNil(place)
        XCTAssertNil(place?.name)
    }

    func testAShortLinkCarriesNothingYet() {
        // maps.apple/p/… has no coordinate until it has been followed,
        // and guessing one would be worse than answering nothing.
        XCTAssertNil(TripMapLink.place(from: "https://maps.apple/p/abc123"))
    }

    func testALinkThatIsNotAMapLinkIsRefused() {
        XCTAssertNil(TripMapLink.place(from: "https://example.test/?ll=48.0,11.0"))
        XCTAssertNil(TripMapLink.place(from: "not a url at all"))
    }

    func testCoordinatesOutsideTheWorldAreRefused() {
        // A transposed or truncated link is likelier than a place at
        // latitude 148, and an entry at a plausible-looking wrong spot
        // is worse than none.
        XCTAssertNil(TripMapLink.place(from: "https://maps.apple.com/?ll=148.0,11.0"))
        XCTAssertNil(TripMapLink.place(from: "https://maps.apple.com/?ll=48.0,311.0"))
    }

    func testAMalformedCoordinateIsRefusedRatherThanHalfRead() {
        XCTAssertNil(TripMapLink.place(from: "https://maps.apple.com/?ll=48.0"))
        XCTAssertNil(TripMapLink.place(from: "https://maps.apple.com/?ll=Norden,Westen"))
    }

    func testNullIslandIsAPlaceLikeAnyOther() {
        // 0,0 is in the ocean and almost certainly a bug upstream — but
        // this function reads links, it does not judge geography, and a
        // special case here would be a rule nobody could find later.
        XCTAssertNotNil(TripMapLink.place(from: "https://maps.apple.com/?ll=0,0"))
    }

    func testRecognisingAMapLink() {
        XCTAssertTrue(TripMapLink.isMapLink(URL(string: "https://maps.apple.com/?ll=1,2")!))
        XCTAssertTrue(TripMapLink.isMapLink(URL(string: "maps:q=x")!))
        XCTAssertFalse(TripMapLink.isMapLink(URL(string: "https://maps.google.com/?q=1,2")!))
    }
}
