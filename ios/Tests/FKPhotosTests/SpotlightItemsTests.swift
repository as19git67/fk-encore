import XCTest
@testable import FKPhotosLib

/// How photos, people and albums are described to Spotlight (#768 §2), and
/// that a hit finds its way back to a deep link.
final class SpotlightItemsTests: XCTestCase {

    private func item(text: String = "", description: String? = nil, names: [String] = [], takenAt: String? = nil) -> SpotlightIndexItem {
        SpotlightIndexItem(id: 42, taken_at: takenAt, text: text, description: description, person_names: names, cursor: "c")
    }

    func testTheIdentifierRoundTripsToADeepLink() {
        XCTAssertEqual(SpotlightItems.deepLink(forIdentifier: SpotlightItems.photoIdentifier(42)), .photo(id: 42))
        XCTAssertEqual(SpotlightItems.deepLink(forIdentifier: "person:5"), .person(id: 5))
        XCTAssertEqual(SpotlightItems.deepLink(forIdentifier: "album:7"), .album(id: 7))
        XCTAssertNil(SpotlightItems.deepLink(forIdentifier: "photo:x"))
        XCTAssertNil(SpotlightItems.deepLink(forIdentifier: "something-else"))
    }

    func testTheFirstLineOfTextIsTheTitle() {
        let attributes = SpotlightItems.photoAttributes(item(text: "Hauptbahnhof\nGleis 3\n\n nach Musterstadt "))
        XCTAssertEqual(attributes.title, "Hauptbahnhof")
        XCTAssertEqual(attributes.contentDescription, "Gleis 3 nach Musterstadt")
        XCTAssertEqual(attributes.textContent, "Hauptbahnhof\nGleis 3\n\n nach Musterstadt ")
    }

    func testADescriptionLeadsTheBodyAndTheTitleWhenThereIsNoText() {
        let withText = SpotlightItems.photoAttributes(item(text: "Schild", description: "Am Bahnhof"))
        XCTAssertEqual(withText.title, "Schild")
        XCTAssertEqual(withText.contentDescription, "Am Bahnhof")

        let descriptionOnly = SpotlightItems.photoAttributes(item(description: "Am Bahnhof"))
        XCTAssertEqual(descriptionOnly.title, "Am Bahnhof")
        XCTAssertNil(descriptionOnly.contentDescription)
        XCTAssertEqual(descriptionOnly.textContent, "Am Bahnhof")
    }

    func testALongTitleIsCut() {
        let attributes = SpotlightItems.photoAttributes(item(text: String(repeating: "a", count: 200)))
        XCTAssertEqual(attributes.title?.count, 80)
    }

    func testPeopleBecomeKeywordsAndTheDateTheCreationDate() {
        let attributes = SpotlightItems.photoAttributes(
            item(text: "x", names: ["Testperson"], takenAt: "2026-09-17T10:00:00.000Z")
        )
        XCTAssertEqual(attributes.keywords, ["Testperson"])
        XCTAssertEqual(attributes.contentCreationDate?.timeIntervalSince1970, 1_789_639_200)
        XCTAssertNil(SpotlightItems.photoAttributes(item(text: "x")).keywords)
    }

    func testPhotoItemsNeverExpire() {
        let searchable = SpotlightItems.photo(item(text: "x"))
        XCTAssertEqual(searchable.uniqueIdentifier, "photo:42")
        XCTAssertEqual(searchable.domainIdentifier, "photo")
        XCTAssertEqual(searchable.expirationDate, .distantFuture)
    }

    func testAnUnnamedPersonIsNotIndexed() {
        let unnamed = PersonWithFaceCount(
            id: 1, user_id: 1, name: "Unbenannt", cover_face_id: nil, cover_filename: nil,
            cover_bbox: nil, created_at: "", updated_at: "", faceCount: 3
        )
        XCTAssertNil(SpotlightItems.person(unnamed))
    }

    func testTheIdSetRoundTripsThroughItsCompactEncoding() {
        let ids: Set<Int> = [1, 42, 75_000, 2_147_483_648]
        XCTAssertEqual(SpotlightIndexState.decodeIds(SpotlightIndexState.encodeIds(ids)), ids)
        XCTAssertEqual(SpotlightIndexState.decodeIds(Data()), [])
    }
}
