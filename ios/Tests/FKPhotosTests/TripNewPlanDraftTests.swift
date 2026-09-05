import XCTest
@testable import FKPhotosLib

/// The decisions behind the "new trip" screen.
///
/// Two of them are worth guarding. A draft is plannable only once a
/// coordinate has been *chosen* — the planner has no forward geocoder,
/// so a place name that never became a pin would either be dropped or,
/// worse, guessed at. And a sentence fills in only what it actually
/// said: a remark about the pace must not quietly reset the length of
/// the trip.
final class TripNewPlanDraftTests: XCTestCase {
    private let lisbon = TripPlace(
        name: "Beispielstadt",
        subtitle: "Beispielland",
        latitude: 38.7,
        longitude: -9.1,
    )

    func testADraftWithoutAPlaceCannotBePlanned() {
        var draft = TripNewPlanDraft()
        draft.title = "Sommer"
        draft.days = 5
        XCTAssertFalse(draft.isPlannable)
        XCTAssertNil(draft.createRequest())
    }

    func testAPickedPlaceMakesItPlannable() {
        var draft = TripNewPlanDraft()
        draft.anchor = lisbon
        XCTAssertTrue(draft.isPlannable)

        let request = draft.createRequest()
        XCTAssertEqual(request?.legs.count, 1)
        XCTAssertEqual(request?.legs.first?.anchor.lat, 38.7)
        XCTAssertEqual(request?.legs.first?.anchor.lon, -9.1)
    }

    func testTheTripIsNamedAfterThePlaceWhenNobodyNamedIt() {
        var draft = TripNewPlanDraft()
        draft.anchor = lisbon
        XCTAssertEqual(draft.effectiveTitle, "Beispielstadt")

        draft.title = "  Herbstferien  "
        XCTAssertEqual(draft.effectiveTitle, "Herbstferien")
    }

    func testASentenceFillsTheFormWithoutTouchingThePin() {
        var draft = TripNewPlanDraft()
        draft.anchor = lisbon
        draft.apply(TripInterpretedConstraints(
            title: "Städtereise",
            placeHint: "Musterstadt",
            days: 4,
            pace: "relaxed",
            group: .init(withChildren: true, limitedMobility: nil),
        ))

        XCTAssertEqual(draft.title, "Städtereise")
        XCTAssertEqual(draft.days, 4)
        XCTAssertEqual(draft.pace, .relaxed)
        XCTAssertTrue(draft.withChildren)
        XCTAssertEqual(draft.placeHint, "Musterstadt")
        // The sentence named a different town than the one on the map.
        // It becomes a suggestion for the search field, never the anchor
        // — a name is not a coordinate.
        XCTAssertEqual(draft.anchor, lisbon)
    }

    func testASentenceLeavesAloneWhatItDidNotMention() {
        var draft = TripNewPlanDraft()
        draft.days = 7
        draft.title = "Herbstferien"
        draft.apply(TripInterpretedConstraints(pace: "packed"))

        XCTAssertEqual(draft.days, 7)
        XCTAssertEqual(draft.title, "Herbstferien")
        XCTAssertEqual(draft.pace, .packed)
    }

    func testTheLengthIsClampedToWhatTheServerAccepts() {
        var draft = TripNewPlanDraft()
        draft.apply(TripInterpretedConstraints(days: 40))
        XCTAssertEqual(draft.days, TripNewPlanDraft.maxDays)

        draft.apply(TripInterpretedConstraints(days: 0))
        XCTAssertEqual(draft.days, TripNewPlanDraft.minDays)

        draft.apply(TripInterpretedConstraints(radiusM: 5))
        XCTAssertEqual(draft.radiusM, TripNewPlanDraft.minRadiusM)
    }

    func testAnUnknownPaceIsIgnoredRatherThanGuessed() {
        var draft = TripNewPlanDraft()
        draft.pace = .relaxed
        draft.apply(TripInterpretedConstraints(pace: "gemütlich"))
        XCTAssertEqual(draft.pace, .relaxed)
    }

    func testCompanyIsOnlyEverSwitchedOn() {
        // A later sentence that says nothing about the child is not a
        // statement that the child stayed home.
        var draft = TripNewPlanDraft()
        draft.apply(TripInterpretedConstraints(group: .init(withChildren: true,
                                                            limitedMobility: nil)))
        XCTAssertTrue(draft.withChildren)

        draft.apply(TripInterpretedConstraints(days: 2))
        XCTAssertTrue(draft.withChildren)
    }

    func testGroupIsOmittedWhenNobodyNeedsIt() {
        var draft = TripNewPlanDraft()
        draft.anchor = lisbon
        XCTAssertNil(draft.createRequest()?.group)

        draft.limitedMobility = true
        XCTAssertEqual(draft.createRequest()?.group?.limitedMobility, true)
    }

    func testEmptyListsAreLeftOutRatherThanSentAsEmpty() {
        // An empty `categories` means "all of them" to the search; an
        // absent one means the same thing but says it honestly.
        var draft = TripNewPlanDraft()
        draft.anchor = lisbon
        XCTAssertNil(draft.createRequest()?.categories)
        XCTAssertNil(draft.createRequest()?.interests)

        draft.categories = ["museum"]
        XCTAssertEqual(draft.createRequest()?.categories, ["museum"])
    }
}
