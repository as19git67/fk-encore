import XCTest
@testable import FKPhotosLib

/// Finding one entry in a grown collection (§20.1).
///
/// The list is sorted into places, which makes "wo war noch mal dieser
/// Biergarten?" a scroll through groups it is not in. These tests pin
/// what the search has to reach: every group at once, every field a
/// person could have written — and the group's name, which no entry
/// carries but everybody remembers things by.
final class TripIdeaSearchTests: XCTestCase {

    private func idea(
        _ id: Int,
        name: String? = "Ort",
        title: String? = nil,
        note: String? = nil,
        addedBy: String? = nil,
        category: String = "viewpoint",
        lat: Double = 43.47,
        lon: Double = 11.04,
    ) -> TripIdea {
        TripIdea(
            id: id,
            ownerId: 1,
            osmRef: "node:\(id)",
            name: name,
            title: title,
            lat: lat,
            lon: lon,
            category: category,
            dwellMinutes: 30,
            note: note,
            sourceUrl: nil,
            unmatched: false,
            validFrom: nil,
            validTo: nil,
            addedBy: addedBy,
            addedAt: "2026-09-01T10:00:00Z",
        )
    }

    private func cluster(_ id: Int, _ ideas: [TripIdea]) -> TripIdeaCluster {
        TripIdeaCluster(id: id, ideas: ideas, centre: TripIdeaClusters.centre(of: ideas))
    }

    // MARK: - What counts as a match

    func testTheNameTheFamilyGaveItAndTheOneOnTheSignBothCount() {
        // A renamed entry is still the place whose name is on the door.
        let renamed = idea(1, name: "Kaiserbrunnen", title: "Der Brunnen mit den Fischen")
        XCTAssertTrue(TripIdeaSearch.matches(renamed, groupName: nil, needle: "fische"))
        XCTAssertTrue(TripIdeaSearch.matches(renamed, groupName: nil, needle: "kaiser"))
    }

    func testTheNoteAndWhoKeptItAreSearchable() {
        // "Der Biergarten, den Anna gemerkt hat" is half the information
        // (§20.1) — and half of what somebody types.
        let entry = idea(1, name: "Gasthaus", note: "bester Kaiserschmarrn", addedBy: "Anna")
        XCTAssertTrue(TripIdeaSearch.matches(entry, groupName: nil, needle: "schmarrn"))
        XCTAssertTrue(TripIdeaSearch.matches(entry, groupName: nil, needle: "anna"))
    }

    func testTheKindOfPlaceCounts() {
        let entry = idea(1, name: "Ohne Namen", category: "museum")
        XCTAssertTrue(TripIdeaSearch.matches(entry, groupName: nil, needle: "museum"))
    }

    func testAnEntryThatMatchesNothingIsNotAMatch() {
        XCTAssertFalse(TripIdeaSearch.matches(idea(1, name: "Gasthaus"),
                                              groupName: "Lissabon", needle: "burg"))
    }

    // MARK: - The group's name is part of the entry

    func testTheGroupNameFindsEntriesThatNeverSpellIt() {
        let entry = idea(1, name: "Miradouro")
        XCTAssertTrue(TripIdeaSearch.matches(entry, groupName: "Lissabon", needle: "lissabon"))
        // …and only because the group says so.
        XCTAssertFalse(TripIdeaSearch.matches(entry, groupName: nil, needle: "lissabon"))
    }

    func testAGroupWhoseNameMatchesKeepsEveryEntryInIt() {
        let group = cluster(1, [idea(1, name: "Miradouro"), idea(2, name: "Markthalle")])
        let kept = TripIdeaSearch.filter([group], query: "Lissabon") { _ in "Lissabon" }
        XCTAssertEqual(kept.count, 1)
        XCTAssertEqual(kept.first?.ideas.map(\.id), [1, 2])
    }

    func testAGroupWithNoNameYetIsStillSearchedByItsEntries() {
        // The geocoder answers late; until it does, matching on the
        // entries is the honest half of the answer rather than none.
        let group = cluster(1, [idea(1, name: "Biergarten"), idea(2, name: "Markthalle")])
        let kept = TripIdeaSearch.filter([group], query: "bier") { _ in nil }
        XCTAssertEqual(kept.first?.ideas.map(\.id), [1])
    }

    // MARK: - Across the groups, not inside one

    func testTheSearchReachesEveryGroupAndDropsTheOnesLeftEmpty() {
        let here = cluster(1, [idea(1, name: "Biergarten am Fluss"), idea(2, name: "Kirche")])
        let faraway = cluster(2, [idea(3, name: "Museum"), idea(4, name: "Biergarten Süd")])
        let kept = TripIdeaSearch.filter([here, faraway], query: "biergarten") { _ in nil }
        XCTAssertEqual(kept.map(\.id), [1, 2])
        XCTAssertEqual(kept.flatMap { $0.ideas.map(\.id) }, [1, 4])
    }

    func testAGroupThatKeepsNothingDisappearsEntirely() {
        let here = cluster(1, [idea(1, name: "Kirche")])
        let faraway = cluster(2, [idea(2, name: "Biergarten")])
        let kept = TripIdeaSearch.filter([here, faraway], query: "biergarten") { _ in nil }
        XCTAssertEqual(kept.map(\.id), [2])
    }

    func testTheGroupsKeepTheirPlaceAndTheirCentre() {
        // The screen offers an afternoon around the group's centre; a
        // filtered group must not move it somewhere else.
        let group = cluster(1, [idea(1, name: "Biergarten", lat: 43.0, lon: 11.0),
                                idea(2, name: "Kirche", lat: 43.2, lon: 11.2)])
        let kept = TripIdeaSearch.filter([group], query: "bier") { _ in nil }
        XCTAssertEqual(kept.first?.centre.lat, group.centre.lat)
        XCTAssertEqual(kept.first?.centre.lon, group.centre.lon)
    }

    // MARK: - No search

    func testAnEmptySearchIsNoSearchRatherThanNoResults() {
        let group = cluster(1, [idea(1), idea(2)])
        XCTAssertEqual(TripIdeaSearch.filter([group], query: "   ") { _ in nil }.count, 1)
        XCTAssertTrue(TripIdeaSearch.matches(idea(1), groupName: nil, needle: ""))
    }

    func testTheSearchIgnoresCaseAndSurroundingSpace() {
        let group = cluster(1, [idea(1, name: "Biergarten")])
        XCTAssertEqual(TripIdeaSearch.filter([group], query: "  BIERGARTEN  ") { _ in nil }.count, 1)
    }

    // MARK: - What the count says

    func testTheCountOnlySpeaksWhenSomethingIsHidden() {
        XCTAssertNil(TripIdeaSearch.countLabel(shown: 40, of: 40))
        XCTAssertEqual(TripIdeaSearch.countLabel(shown: 3, of: 40), "3 von 40 Ideen")
    }
}
