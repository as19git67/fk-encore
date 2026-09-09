import XCTest
@testable import FKPhotosLib

/// What a spot says about itself, on the one screen both kinds share.
///
/// Two things here are easy to get wrong in a way nothing catches. A
/// place OpenStreetMap left unnamed has to stay identifiable without
/// anybody inventing a name for it (§10.4, §15.3) — eleven rows reading
/// "Unbenannter Ort" are data the app has and a person cannot use. And
/// the note somebody wrote next to a find has to survive the trip from
/// pool entry to planned stop, because the moment it is planned is
/// exactly the moment §9.2 says its reason must not disappear.
final class TripCategoryLabelTests: XCTestCase {
    func testAnUnnamedSpotSaysWhatItIsInstead() {
        XCTAssertEqual(TripCategory.unnamed("viewpoint"), "Aussichtspunkt, ohne Namen")
        XCTAssertEqual(TripCategory.unnamed("worship"), "Kirche oder Tempel, ohne Namen")
    }

    func testAnUnknownCategoryFallsBackRatherThanShowingItsId() {
        // A category the app has not learned about yet still has to
        // read as German, not as "brewery".
        XCTAssertEqual(TripCategory.unnamed("brewery"), "Unbenannter Ort")
    }

    func testALabelIsNeverTheRawId() {
        for id in ["sight", "museum", "viewpoint", "worship", "theatre",
                   "food", "cafe", "essentials", "outdoors"] {
            XCTAssertNotEqual(TripCategory.label(id), id, "\(id) has no German label")
        }
    }
}

final class TripSpotDetailTests: XCTestCase {
    private func candidate(
        name: String? = "Museum Beispiel",
        category: String = "museum",
        note: String? = nil,
        sourceUrl: String? = nil,
        unmatched: Bool? = nil,
        title: String? = nil,
        localName: String? = nil,
        wikipediaUrl: String? = nil,
        photoStop: Bool? = nil,
    ) -> TripCandidate {
        TripCandidate(
            osmRef: "node:1",
            name: name,
            lat: 48.37,
            lon: 10.9,
            category: category,
            dwellMinutes: 90,
            score: 3,
            reasons: ["in Wikidata verzeichnet"],
            origin: note == nil ? "search" : "manual",
            note: note,
            sourceUrl: sourceUrl,
            unmatched: unmatched,
            title: title,
            localName: localName,
            wikipediaUrl: wikipediaUrl,
            photoStop: photoStop,
        )
    }

    private func stop(
        note: String? = nil,
        sourceUrl: String? = nil,
        title: String? = nil,
        localName: String? = nil,
        wikipediaUrl: String? = nil,
        photoStop: Bool? = nil,
    ) -> TripStop {
        TripStop(
            rowId: 7,
            osmRef: "node:1",
            name: "Café Beispielhof",
            lat: 48.37,
            lon: 10.9,
            category: "cafe",
            dwellMinutes: 30,
            travelFromPrevious: TripTravel(minutes: 8, distanceM: 600, travelClass: "short_walk"),
            status: "planned",
            pinned: true,
            note: note,
            sourceUrl: sourceUrl,
            title: title,
            localName: localName,
            wikipediaUrl: wikipediaUrl,
            photoStop: photoStop,
        )
    }

    func testThePhotoStopMarkTravelsToTheDetailScreen() {
        // The mark decides whether the sun gets a say (§7.3), so the
        // screen that shows the light has to know about it — from a
        // pool candidate and from a planned stop alike.
        XCTAssertTrue(TripSpotDetail(candidate(photoStop: true)).photoStop)
        XCTAssertTrue(TripSpotDetail(stop(photoStop: true)).photoStop)
        // Absent means no, not unknown: an older server that has never
        // heard of the flag must not light the camera up everywhere.
        XCTAssertFalse(TripSpotDetail(candidate()).photoStop)
        XCTAssertFalse(TripSpotDetail(stop(photoStop: nil)).photoStop)
    }

    func testAPoolCandidateBringsItsNoteAndItsSource() {
        let detail = TripSpotDetail(candidate(
            note: "beste Pastéis laut Blog",
            sourceUrl: "https://beispiel.test/zehn-cafes"))

        XCTAssertEqual(detail.note, "beste Pastéis laut Blog")
        XCTAssertEqual(detail.sourceUrl, "https://beispiel.test/zehn-cafes")
        XCTAssertEqual(detail.reasons, ["in Wikidata verzeichnet"])
    }

    func testAPlannedStopKeepsTheNoteItWasPlannedWith() {
        // The pool row is deleted when a find is placed. If the note did
        // not travel with it, acting on the find would be the moment its
        // reason vanished — the opposite of §9.2.
        let detail = TripSpotDetail(stop(note: "beste Pastéis laut Blog",
                                         sourceUrl: "https://beispiel.test/zehn-cafes"))

        XCTAssertEqual(detail.note, "beste Pastéis laut Blog")
        XCTAssertEqual(detail.sourceUrl, "https://beispiel.test/zehn-cafes")
    }

    func testAPlannedStopClaimsNoReasonsItNoLongerHas() {
        // The scoring reasons lived on the pool entry. An empty section
        // is honest; a made-up one is not (§10.4).
        XCTAssertEqual(TripSpotDetail(stop()).reasons, [])
    }

    func testAnUnnamedCandidateIsStillTellableApart() {
        let detail = TripSpotDetail(candidate(name: nil, category: "viewpoint"))
        XCTAssertEqual(detail.displayName, "Aussichtspunkt, ohne Namen")
        // And the name really is missing, so the screen can say so
        // rather than passing the description off as data.
        XCTAssertNil(detail.name)
    }

    func testAnOlderServerWithoutTheProvenanceFieldsStillDecodes() throws {
        // The app ships ahead of the server often enough that a missing
        // field must not turn a whole plan into a decoding failure.
        let json = """
        {"osmRef":"node:1","name":"Museum","lat":48.37,"lon":10.9,"category":"museum",
         "dwellMinutes":90,"score":3,"reasons":[]}
        """
        let decoded = try JSONDecoder().decode(TripCandidate.self, from: Data(json.utf8))

        XCTAssertNil(decoded.note)
        XCTAssertNil(decoded.origin)
        XCTAssertFalse(decoded.isManual)
        XCTAssertFalse(TripSpotDetail(decoded).unmatched)
    }

    func testAFindBroughtInByHandSaysSo() {
        XCTAssertTrue(candidate(note: "beste Pastéis laut Blog").isManual)
        XCTAssertFalse(candidate().isManual)
    }

    // MARK: - Names and links (§10.4)

    func testATitleTheGroupGaveItWinsOverTheMapsName() {
        let detail = TripSpotDetail(candidate(title: "Das mit dem Dachgarten"))
        XCTAssertEqual(detail.displayName, "Das mit dem Dachgarten")
        // And the official one stays visible: the ticket desk answers
        // to that one, not to the family's shorthand.
        XCTAssertEqual(detail.officialName, "Museum Beispiel")
    }

    func testWithoutATitleThereIsNoSecondNameToShow() {
        // Otherwise every spot in Europe would carry the same line
        // twice, once as the title and once as "in OpenStreetMap".
        XCTAssertNil(TripSpotDetail(candidate()).officialName)
    }

    func testTheLocalNameTravelsWithTheReadableOne() {
        let detail = TripSpotDetail(candidate(
            name: "Nationalmuseum Beispielstadt", localName: "東京国立博物館"))
        XCTAssertEqual(detail.displayName, "Nationalmuseum Beispielstadt")
        XCTAssertEqual(detail.localName, "東京国立博物館")
    }

    func testAStopKeepsWhatTheMapKnowsAboutIt() {
        let detail = TripSpotDetail(stop(
            title: "Unser Café", localName: "カフェ",
            wikipediaUrl: "https://de.wikipedia.org/wiki/Beispiel"))
        XCTAssertEqual(detail.displayName, "Unser Café")
        XCTAssertEqual(detail.officialName, "Café Beispielhof")
        XCTAssertEqual(detail.localName, "カフェ")
        XCTAssertEqual(detail.wikipediaUrl, "https://de.wikipedia.org/wiki/Beispiel")
    }

    func testAnOlderServerWithoutTheNameFieldsStillDecodes() throws {
        let json = """
        {"osmRef":"node:1","name":"Museum","lat":48.37,"lon":10.9,"category":"museum",
         "dwellMinutes":90,"score":3,"reasons":[]}
        """
        let decoded = try JSONDecoder().decode(TripCandidate.self, from: Data(json.utf8))

        XCTAssertNil(decoded.title)
        XCTAssertNil(decoded.localName)
        XCTAssertNil(decoded.wikipediaUrl)
        XCTAssertEqual(TripSpotDetail(decoded).displayName, "Museum")
    }
}

/// The rules the edit sheet applies before anything is sent (§9.2).
final class TripSpotEditTests: XCTestCase {
    private func detail(title: String? = nil, note: String? = nil,
                        sourceUrl: String? = nil, photoStop: Bool? = nil) -> TripSpotDetail {
        TripSpotDetail(TripCandidate(
            osmRef: "node:1", name: "Museum Beispiel", lat: 48.37, lon: 10.9,
            category: "museum", dwellMinutes: 90, score: 3, reasons: [],
            origin: "search", note: note, sourceUrl: sourceUrl, unmatched: nil,
            title: title, localName: nil, wikipediaUrl: nil, photoStop: photoStop,
        ))
    }

    func testTheSheetOpensOnWhatIsThere() {
        let edit = TripSpotEdit(detail(title: "Dachgarten", note: "Früh hin.",
                                       sourceUrl: "https://beispiel.test"))
        XCTAssertEqual(edit.title, "Dachgarten")
        XCTAssertEqual(edit.note, "Früh hin.")
        XCTAssertEqual(edit.url, "https://beispiel.test")
    }

    func testAnUntitledSpotOpensWithAnEmptyTitleRatherThanTheMapsName() {
        // Pre-filling "Museum Beispiel" would turn every save into a
        // rename nobody asked for.
        XCTAssertEqual(TripSpotEdit(detail()).title, "")
    }

    func testTheSheetOpensWithThePhotoStopAsItStands() {
        // The switch is the one thing on this sheet that changes what
        // the planner does (§7.3), so it must not quietly reset itself
        // every time somebody edits a note.
        XCTAssertTrue(TripSpotEdit(detail(photoStop: true)).photoStop)
        XCTAssertFalse(TripSpotEdit(detail()).photoStop)
    }

    func testWhitespaceIsNotAValue() {
        var edit = TripSpotEdit(osmRef: "node:1")
        edit.note = "   \n "
        XCTAssertEqual(edit.trimmed.note, "")
    }

    func testAnEmptyLinkIsFineAndAHalfOneIsNot() {
        var edit = TripSpotEdit(osmRef: "node:1")
        XCTAssertTrue(edit.urlIsUsable)

        edit.url = "beispiel.test"
        XCTAssertFalse(edit.urlIsUsable, "no scheme is not a link the app can open")

        edit.url = "https://beispiel.test/museum"
        XCTAssertTrue(edit.urlIsUsable)
    }

    func testALinkThatIsNotTheWebIsRefusedBeforeItIsSent() {
        var edit = TripSpotEdit(osmRef: "node:1")
        edit.url = "javascript:alert(1)"
        XCTAssertFalse(edit.urlIsUsable)
    }
}
