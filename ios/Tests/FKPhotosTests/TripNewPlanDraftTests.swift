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

    func testATripWithoutADateSendsNone() {
        // "Vier Tage Lissabon, irgendwann" is a real plan (§4.2), and
        // dating it today would be an invention.
        var draft = TripNewPlanDraft()
        draft.anchor = lisbon
        XCTAssertNil(draft.createRequest()?.legs.first?.startDate)
    }

    // MARK: - Several cities (§4.2)

    private let porto = TripPlace(
        name: "Musterstadt",
        subtitle: "Beispielland",
        latitude: 41.1,
        longitude: -8.6,
    )

    func testASecondCityBecomesASecondLeg() {
        var draft = TripNewPlanDraft()
        draft.anchor = lisbon
        draft.days = 3
        draft.legs.append(TripDraftLeg(place: porto, days: 2, mode: .transit))

        let request = draft.createRequest()
        XCTAssertEqual(request?.legs.count, 2)
        XCTAssertEqual(request?.legs[1].anchor.lat, 41.1)
        XCTAssertEqual(request?.legs[1].days, 2)
        // The mode belongs to the leg: arriving by car does not mean
        // driving around the old town (§4.2).
        XCTAssertEqual(request?.legs[0].mode, "foot")
        XCTAssertEqual(request?.legs[1].mode, "transit")
    }

    func testAHalfPickedSecondCityIsNotPlannable() {
        // Not "plan what you have": it is a trip missing a city, and
        // planning around the gap would quietly drop it.
        var draft = TripNewPlanDraft()
        draft.anchor = lisbon
        draft.legs.append(TripDraftLeg())

        XCTAssertFalse(draft.isPlannable)
        XCTAssertNil(draft.createRequest())
    }

    func testTheTripIsNamedAfterItsRoute() {
        var draft = TripNewPlanDraft()
        draft.anchor = lisbon
        draft.legs.append(TripDraftLeg(place: porto))

        XCTAssertEqual(draft.effectiveTitle, "Beispielstadt → Musterstadt")
        XCTAssertEqual(draft.totalDays, 6)
    }

    func testOnlyTheFirstLegCarriesTheDate() {
        // The server dates the rest in sequence. Two sources for the
        // same fact is how they come to disagree.
        var draft = TripNewPlanDraft()
        draft.anchor = lisbon
        draft.legs.append(TripDraftLeg(place: porto))
        draft.isDated = true
        draft.startDate = TripCalendar.date(fromIsoDay: "2026-09-17")!

        let request = draft.createRequest()
        XCTAssertEqual(request?.legs[0].startDate, "2026-09-17")
        XCTAssertNil(request?.legs[1].startDate)
    }

    func testNobodyTransfersIntoTheStartOfATrip() {
        // How the travellers reached the first city is not this plan's
        // business (§4.2) — even if somebody filled the field in.
        var draft = TripNewPlanDraft()
        var first = TripDraftLeg(place: lisbon)
        first.arriveAt = Date()
        draft.legs = [first, TripDraftLeg(place: porto)]

        XCTAssertNil(draft.createRequest()?.legs[0].transfer)
    }

    func testATransferIsSentOnlyWhenATimeIsKnown() {
        var draft = TripNewPlanDraft()
        draft.anchor = lisbon
        var second = TripDraftLeg(place: porto)
        draft.legs.append(second)
        XCTAssertNil(draft.createRequest()?.legs[1].transfer)

        // A time nobody knows is not a departure at midnight (§15.3).
        second.departAt = Calendar.current.date(
            bySettingHour: 9, minute: 30, second: 0, of: Date())!
        draft.legs[1] = second
        let transfer = draft.createRequest()?.legs[1].transfer
        XCTAssertEqual(transfer?.departAt, "09:30")
        XCTAssertNil(transfer?.arriveAt)
    }

    func testADatedTripSendsTheDayTheTravellerPicked() {
        // The date is what later tells the app which day of the trip
        // today is — there is no "start trip" button.
        var draft = TripNewPlanDraft()
        draft.anchor = lisbon
        draft.isDated = true
        draft.startDate = TripCalendar.date(fromIsoDay: "2026-09-17")!
        XCTAssertEqual(draft.createRequest()?.legs.first?.startDate, "2026-09-17")
    }
}

/// Removing a city from a route being drafted.
///
/// Two mistakes met here, and both are the same mistake: addressing a
/// city by where it sits rather than by which one it is. The list shows
/// the route from the *second* city on, so a delete offset of 0 means
/// `legs[1]` — read as an absolute index it deleted the wrong city and
/// ignored the first row entirely. And a row bound to `legs[2]` keeps
/// that index after the list shrinks, which SwiftUI evaluates once more
/// while dismissing the pushed screen: a crash, not a stale label.
@MainActor
final class TripDraftLegRemovalTests: XCTestCase {
    private func place(_ name: String) -> TripPlace {
        TripPlace(name: name, subtitle: nil, latitude: 48.1, longitude: 11.5)
    }

    /// Three cities, as the screen would have them.
    private func model() -> TripNewPlanViewModel {
        let model = TripNewPlanViewModel()
        model.draft.anchor = place("Erste")
        model.draft.legs.append(TripDraftLeg(place: place("Zweite")))
        model.draft.legs.append(TripDraftLeg(place: place("Dritte")))
        return model
    }

    func testDeletingTheFirstShownRowRemovesTheSecondCity() {
        // Offset 0 is the first *displayed* row, which is legs[1].
        let model = model()
        model.removeLegs(displayedAt: IndexSet(integer: 0))
        XCTAssertEqual(model.draft.legs.compactMap(\.place?.name), ["Erste", "Dritte"])
    }

    func testDeletingTheSecondShownRowRemovesTheThirdCity() {
        let model = model()
        model.removeLegs(displayedAt: IndexSet(integer: 1))
        XCTAssertEqual(model.draft.legs.compactMap(\.place?.name), ["Erste", "Zweite"])
    }

    func testDeletingSeveralAtOnceRemovesExactlyThose() {
        // Every removal moves the indices of what follows, so the rows
        // are resolved to ids before anything goes.
        let model = model()
        model.draft.legs.append(TripDraftLeg(place: place("Vierte")))
        model.removeLegs(displayedAt: IndexSet([0, 2]))
        XCTAssertEqual(model.draft.legs.compactMap(\.place?.name), ["Erste", "Dritte"])
    }

    func testAnOffsetPastTheEndRemovesNothing() {
        let model = model()
        model.removeLegs(displayedAt: IndexSet(integer: 9))
        XCTAssertEqual(model.draft.legs.count, 3)
    }

    func testTheFirstCityIsNotRemovableThisWay() {
        // There is no row for it: the route list starts at the second.
        let model = model()
        model.removeLegs(displayedAt: IndexSet())
        XCTAssertEqual(model.draft.legs.compactMap(\.place?.name), ["Erste", "Zweite", "Dritte"])
    }

    func testABindingSurvivesItsCityBeingRemoved() {
        // What actually crashed: the pushed editor is evaluated once
        // more on its way out, after the list has shrunk.
        let model = model()
        let id = model.draft.legs[1].id
        let binding = model.binding(for: id)
        model.removeLegs(displayedAt: IndexSet(integer: 0))

        XCTAssertNil(binding.wrappedValue.place)
        // And writing through a dead binding changes nothing rather
        // than resurrecting a city or overwriting its neighbour.
        binding.wrappedValue.days = 9
        XCTAssertEqual(model.draft.legs.compactMap(\.place?.name), ["Erste", "Dritte"])
        XCTAssertFalse(model.draft.legs.contains { $0.days == 9 })
    }

    func testABindingWritesThroughToTheRightCity() {
        let model = model()
        let binding = model.binding(for: model.draft.legs[2].id)
        binding.wrappedValue.days = 5
        XCTAssertEqual(model.draft.legs[2].days, 5)
        XCTAssertNotEqual(model.draft.legs[1].days, 5)
    }

    func testPositionsFollowTheCityRatherThanTheRow() {
        let model = model()
        let third = model.draft.legs[2].id
        XCTAssertEqual(model.position(of: third), 2)
        XCTAssertEqual(model.legBefore(third)?.place?.name, "Zweite")

        model.removeLegs(displayedAt: IndexSet(integer: 0))

        XCTAssertEqual(model.position(of: third), 1)
        XCTAssertEqual(model.legBefore(third)?.place?.name, "Erste")
    }
}
