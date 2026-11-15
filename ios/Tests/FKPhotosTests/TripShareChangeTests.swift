import XCTest
@testable import FKPhotosLib

/// A find or idea saved through the share sheet has to reach the trip
/// that is already open, not only the next time it is opened.
final class TripShareChangeNoteTests: XCTestCase {
    private var store: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "trip-share-change-\(UUID().uuidString)"
        store = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        store.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    func testNoNoteMeansNothingChanged() {
        XCTAssertNil(TripShareChange.take(from: store))
    }

    func testSeveralSharesMergeIntoOneNote() {
        TripShareChange.note(planId: 7, in: store)
        TripShareChange.note(planId: 7, in: store)
        TripShareChange.note(planId: 9, in: store)
        TripShareChange.note(planId: nil, in: store)

        let change = TripShareChange.take(from: store)
        XCTAssertEqual(change?.planIds, [7, 9])
        XCTAssertEqual(change?.ideas, true)
    }

    func testReadingClearsTheNote() {
        TripShareChange.note(planId: 7, in: store)
        XCTAssertNotNil(TripShareChange.take(from: store))
        XCTAssertNil(TripShareChange.take(from: store))
    }

    func testAnIdeaAloneTouchesNoTrip() {
        TripShareChange.note(planId: nil, in: store)
        let change = TripShareChange.take(from: store)
        XCTAssertEqual(change?.planIds, [])
        XCTAssertEqual(change?.ideas, true)
    }
}

@MainActor
final class TripShareChangeRelayTests: XCTestCase {
    private var store: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "trip-share-relay-\(UUID().uuidString)"
        store = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        store.removePersistentDomain(forName: suiteName)
        TripPlannerViewModel.forget(planId: 4201)
        TripPlannerViewModel.forget(planId: 4202)
        super.tearDown()
    }

    func testTheOpenTripReadsAgain() {
        let open = TripPlannerViewModel.shared(for: 4201)
        let other = TripPlannerViewModel.shared(for: 4202)
        TripShareChange.note(planId: 4201, in: store)

        let relay = TripShareChangeRelay(store: store)
        XCTAssertNotNil(relay.apply())

        XCTAssertEqual(open.outsideChanges, 1)
        XCTAssertEqual(other.outsideChanges, 0)
    }

    func testAnIdeaBumpsTheCollection() {
        TripShareChange.note(planId: nil, in: store)
        let relay = TripShareChangeRelay(store: store)

        relay.apply()

        XCTAssertEqual(relay.ideasVersion, 1)
    }

    func testNothingNewChangesNothing() {
        let open = TripPlannerViewModel.shared(for: 4201)
        let relay = TripShareChangeRelay(store: store)

        XCTAssertNil(relay.apply())

        XCTAssertEqual(open.outsideChanges, 0)
        XCTAssertEqual(relay.ideasVersion, 0)
    }
}
