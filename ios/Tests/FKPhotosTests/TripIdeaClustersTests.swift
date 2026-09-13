import XCTest
@testable import FKPhotosLib

/// The collection sorted into places (§20.1).
///
/// A flat list is fine at five entries and useless at forty. What the
/// grouping must not do is as important as what it must: it must not
/// reshuffle the screen when somebody saves something, and it must not
/// cut a valley of villages in half because a midpoint fell there.
final class TripIdeaClustersTests: XCTestCase {

    private func idea(_ id: Int, lat: Double, lon: Double) -> TripIdea {
        TripIdea(
            id: id,
            osmRef: "node:\(id)",
            name: "Ort \(id)",
            title: nil,
            lat: lat,
            lon: lon,
            category: "sight",
            dwellMinutes: 30,
            note: nil,
            sourceUrl: nil,
            unmatched: false,
            validFrom: nil,
            validTo: nil,
            addedBy: nil,
            addedAt: "2026-09-01T10:00:00Z",
        )
    }

    /// Roughly n kilometres east of the same latitude.
    private func eastOf(_ lat: Double, _ lon: Double, km: Double) -> (Double, Double) {
        (lat, lon + km / 81.0)
    }

    func testNothingIsNoGroups() {
        XCTAssertTrue(TripIdeaClusters.group([]).isEmpty)
    }

    func testPlacesInOneTownAreOneGroup() {
        let (lat, lon) = (43.47, 11.04)
        let near = eastOf(lat, lon, km: 3)
        let groups = TripIdeaClusters.group([
            idea(1, lat: lat, lon: lon),
            idea(2, lat: near.0, lon: near.1),
        ])

        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].ideas.map(\.id), [1, 2])
    }

    func testPlacesAContinentApartAreNot() {
        let groups = TripIdeaClusters.group([
            idea(1, lat: 43.47, lon: 11.04),
            idea(2, lat: 48.14, lon: 11.58),
        ])

        XCTAssertEqual(groups.count, 2)
    }

    func testAChainOfVillagesStaysOneGroup() {
        // Single-link on purpose: each hop is inside the radius, so the
        // valley is one place even though its ends are not within one
        // radius of each other. A cut here would fall where nobody
        // would draw a line on the ground.
        let (lat, lon) = (43.0, 11.0)
        let b = eastOf(lat, lon, km: 20)
        let c = eastOf(lat, lon, km: 40)
        let groups = TripIdeaClusters.group([
            idea(1, lat: lat, lon: lon),
            idea(2, lat: b.0, lon: b.1),
            idea(3, lat: c.0, lon: c.1),
        ])

        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].ideas.count, 3)
    }

    func testGroupsKeepTheListsOwnOrder() {
        // The collection arrives newest first and stays that way at the
        // group level. Sorting by size would move the screen under
        // somebody's thumb every time they saved something.
        let far = (48.14, 11.58)
        let groups = TripIdeaClusters.group([
            idea(9, lat: far.0, lon: far.1),
            idea(1, lat: 43.47, lon: 11.04),
            idea(2, lat: 43.48, lon: 11.05),
        ])

        XCTAssertEqual(groups.map { $0.ideas.first?.id }, [9, 1])
    }

    func testAGroupKeepsItsIdentityWhenAnotherGrows() {
        // SwiftUI keeps a section only while its id does. The id is the
        // lowest entry in the group, so adding somewhere else leaves it
        // alone.
        let tuscany = [idea(1, lat: 43.47, lon: 11.04), idea(2, lat: 43.48, lon: 11.05)]
        let before = TripIdeaClusters.group(tuscany)
        let after = TripIdeaClusters.group(tuscany + [idea(9, lat: 48.14, lon: 11.58)])

        XCTAssertEqual(before[0].id, after.first(where: { $0.ideas.count == 2 })?.id)
    }

    func testTheCentreSitsBetweenTheEntries() {
        let centre = TripIdeaClusters.centre(of: [
            idea(1, lat: 43.0, lon: 11.0),
            idea(2, lat: 43.2, lon: 11.4),
        ])

        XCTAssertEqual(centre.lat, 43.1, accuracy: 0.0001)
        XCTAssertEqual(centre.lon, 11.2, accuracy: 0.0001)
    }

    func testAnUnnamedGroupSaysHowManyRatherThanInventingAPlace() {
        let one = TripIdeaClusters.group([idea(1, lat: 43.0, lon: 11.0)])
        XCTAssertEqual(one[0].fallbackTitle, "Ein Ort")

        let three = TripIdeaClusters.group([
            idea(1, lat: 43.0, lon: 11.0),
            idea(2, lat: 43.01, lon: 11.01),
            idea(3, lat: 43.02, lon: 11.02),
        ])
        XCTAssertEqual(three[0].fallbackTitle, "3 Orte")
    }
}
