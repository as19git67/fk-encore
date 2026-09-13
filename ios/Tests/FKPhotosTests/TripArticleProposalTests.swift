import XCTest
@testable import FKPhotosLib

/// What a proposal out of an article still needs (§9.2 case 2, §9.3).
///
/// Three kinds come back and they look alike on screen: one resolved,
/// one that needs a choice, one the region does not know. What follows
/// from each is different — add it, ask which, or do not add it at all
/// — and getting that wrong either loses a find or invents a place.
final class TripArticleProposalTests: XCTestCase {

    private func option(_ ref: String, lat: Double, lon: Double) -> TripShareProposal.Option {
        TripShareProposal.Option(
            osmRef: ref, name: "Santa Maria", lat: lat, lon: lon,
            categories: ["worship"], legIndex: 0, distanceM: 420,
        )
    }

    private func proposal(
        verdict: String,
        position: TripShareProposal.Coordinate? = nil,
        osmRef: String? = nil,
        options: [TripShareProposal.Option] = [],
    ) -> TripShareProposal {
        TripShareProposal(
            name: "Café Beispielhof",
            verdict: verdict,
            position: position,
            osmRef: osmRef,
            categories: [],
            legIndex: nil,
            options: options,
            quote: "Im Café Beispielhof gibt es den besten Kuchen.",
            placeHint: nil,
            kindHint: nil,
        )
    }

    func testAResolvedNameGoesInAsItIs() {
        let resolved = proposal(
            verdict: "unique",
            position: .init(lat: 43.47, lon: 11.04),
            osmRef: "node:1",
        )

        XCTAssertEqual(resolved.placement(chosen: nil)?.lat, 43.47)
        // OpenStreetMap knows it, so its category supplies the duration
        // — asking would replace a real figure with a default.
        XCTAssertFalse(resolved.needsADuration(chosen: nil))
    }

    func testAnAmbiguousNameHasNowhereToGoUntilItIsDecided() {
        let ambiguous = proposal(
            verdict: "ambiguous",
            options: [option("way:1", lat: 43.77, lon: 11.24)],
        )

        XCTAssertNil(ambiguous.placement(chosen: nil))
        XCTAssertEqual(ambiguous.missing, .whichPlace)
    }

    func testTheChosenOptionWinsAndBringsItsOwnDuration() {
        let ambiguous = proposal(
            verdict: "ambiguous",
            options: [option("way:1", lat: 43.77, lon: 11.24)],
        )
        let picked = option("way:1", lat: 43.77, lon: 11.24)

        XCTAssertEqual(ambiguous.placement(chosen: picked)?.lon, 11.24)
        XCTAssertFalse(ambiguous.needsADuration(chosen: picked))
    }

    func testANameTheRegionDoesNotKnowIsANoteAndNotACandidate() {
        let unplaced = proposal(verdict: "none")

        XCTAssertNil(unplaced.placement(chosen: nil))
        XCTAssertFalse(unplaced.isAddable)
    }

    func testAPinWithoutAnEntryIsTheOneCaseThatMustBeAsked() {
        // A coordinate and no OSM entry behind it: no category, so no
        // duration anybody could look up. The single question §9.2
        // allows the planner to ask.
        let pin = proposal(verdict: "coordinate", position: .init(lat: 43.4, lon: 11.0))

        XCTAssertNotNil(pin.placement(chosen: nil))
        XCTAssertTrue(pin.needsADuration(chosen: nil))
        XCTAssertEqual(pin.missing, .howLong)
    }
}
