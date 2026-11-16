import XCTest
@testable import FKPhotosLib
@testable import F4milCore

/// The plan the phone keeps (§3.9).
///
/// Three things decide whether this feature helps or misleads: that the
/// stored plan survives being written and read back, that it is used
/// only when the server genuinely could not be reached, and that the
/// screen can say how old it is. All three are tested here; the fourth
/// — that a coarse plan is worth having offline — is a property of
/// §4.1 and needs no test.
final class TripOfflineBundleTests: XCTestCase {

    private let bundleJSON = """
    {
      "generatedAt": "2026-06-18T06:00:00.000Z",
      "omits": ["weather", "map"],
      "plan": {
        "id": 7, "ownerId": 1, "title": "Beispielreise",
        "legs": [
          { "id": 11, "position": 0, "title": "Beispielstadt",
            "anchor": { "lat": 48.37, "lon": 10.9 },
            "anchorRadiusM": null, "mode": "foot", "regionDb": "nom_west",
            "startDate": "2026-06-18",
            "days": [
              { "id": 21, "dayIndex": 0, "detailed": true, "fixpoints": [],
                "blocks": [
                  { "id": "morning", "rowId": 41, "label": "Vormittag", "kind": "spots",
                    "budgetMinutes": 210, "usedMinutes": 90,
                    "stops": [
                      { "rowId": 51, "osmRef": "node:1", "name": "Stadtmuseum",
                        "lat": 48.371, "lon": 10.901, "category": "museum",
                        "dwellMinutes": 90, "status": "planned", "pinned": false,
                        "travelFromPrevious": { "minutes": 5, "distanceM": 390,
                                                "travelClass": "short_walk" } }
                    ] }
                ] }
            ],
            "pool": [
              { "osmRef": "node:2", "name": "Aussichtsturm", "lat": 48.372,
                "lon": 10.902, "category": "viewpoint", "dwellMinutes": 30,
                "score": 3.5, "reasons": ["ihr wolltet: Aussichtspunkte"] }
            ] }
        ]
      },
      "light": [
        { "legIndex": 0, "dayIndex": 0, "date": "2026-06-18",
          "light": {
            "day": "2026-06-18",
            "windows": [
              { "kind": "golden", "from": "2026-06-18T18:40:00.000Z",
                "to": "2026-06-18T19:40:00.000Z", "fromMinutes": 1240, "toMinutes": 1300 }
            ],
            "spots": [
              { "osmRef": "node:1", "facade": "frontal",
                "best": { "kind": "golden", "from": "2026-06-18T18:40:00.000Z",
                          "to": "2026-06-18T19:40:00.000Z",
                          "fromMinutes": 1240, "toMinutes": 1300 } }
            ] } }
      ]
    }
    """

    private func bundle() throws -> TripOfflineBundle {
        try JSONDecoder().decode(TripOfflineBundle.self, from: Data(bundleJSON.utf8))
    }

    private func store() throws -> TripOfflineStore {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("offline-\(UUID().uuidString)", isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return TripOfflineStore(directory: directory)
    }

    // MARK: - What it carries

    func testTheStoredPlanIsTheWholePlan() throws {
        let bundle = try bundle()

        XCTAssertEqual(bundle.plan.legs.count, 1)
        XCTAssertEqual(bundle.plan.legs[0].days[0].blocks[0].stops.first?.name, "Stadtmuseum")
        // The pool travels along: "was stattdessen?" has to be
        // answerable in a tunnel (§5).
        XCTAssertEqual(bundle.plan.legs[0].pool.count, 1)
    }

    func testTheLightOfADayIsFoundByItsPosition() throws {
        let bundle = try bundle()

        XCTAssertEqual(bundle.lightOfDay(legIndex: 0, dayIndex: 0)?.day, "2026-06-18")
        XCTAssertNil(bundle.lightOfDay(legIndex: 0, dayIndex: 1))
        XCTAssertNil(bundle.lightOfDay(legIndex: 1, dayIndex: 0))
    }

    func testItNamesWhatItLeavesOut() throws {
        // §14: no map offline, and a stale forecast is worse than none.
        XCTAssertEqual(try bundle().omits, ["weather", "map"])
    }

    // MARK: - Keeping it

    func testItComesBackTheWayItWentIn() throws {
        let store = try store()
        let saved = try bundle()

        try store.save(saved, planId: 7)
        let read = store.load(planId: 7)

        XCTAssertEqual(read?.bundle.plan.id, 7)
        XCTAssertEqual(read?.bundle.plan.legs[0].days[0].blocks[0].stops.first?.osmRef, "node:1")
        XCTAssertEqual(read?.bundle.light.count, 1)
    }

    func testAPlanThatWasNeverStoredIsSimplyAbsent() throws {
        let store = try store()

        XCTAssertFalse(store.has(planId: 7))
        XCTAssertNil(store.load(planId: 7))
        XCTAssertNil(store.storedAt(planId: 7))
    }

    func testDeletingLeavesNothingBehind() throws {
        let store = try store()
        try store.save(try bundle(), planId: 7)

        store.remove(planId: 7)

        XCTAssertFalse(store.has(planId: 7))
        XCTAssertNil(store.load(planId: 7))
    }

    func testOnePlanDoesNotOverwriteAnother() throws {
        let store = try store()
        try store.save(try bundle(), planId: 7)

        XCTAssertTrue(store.has(planId: 7))
        XCTAssertFalse(store.has(planId: 8))
    }

    // MARK: - The itinerary and the list

    func testABundleFromAnOlderBuildHasNoItineraryAndStillReads() throws {
        XCTAssertNil(try bundle().itinerary)
    }

    func testTheItineraryTravelsAlong() throws {
        let withItinerary = bundleJSON.replacingOccurrences(
            of: "\"omits\": [\"weather\", \"map\"],",
            with: """
            "omits": ["weather", "map"],
            "itinerary": { "planId": 7, "startDate": "2026-06-18", "home": null,
              "items": [ { "kind": "stay", "legId": 11, "title": "Beispielstadt", "days": 1,
                           "startDate": "2026-06-18", "endDate": "2026-06-18" } ] },
            """)
        let store = try store()
        let decoded = try JSONDecoder().decode(TripOfflineBundle.self, from: Data(withItinerary.utf8))

        try store.save(decoded, planId: 7)
        let read = store.load(planId: 7)?.bundle.itinerary

        XCTAssertEqual(read?.planId, 7)
        XCTAssertEqual(read?.items.first?.kind, .stay)
        XCTAssertEqual(read?.items.first?.legId, 11)
    }

    func testStoredIdsAreTheBundlesOnThePhone() throws {
        let store = try store()
        try store.save(try bundle(), planId: 7)
        try store.save(try bundle(), planId: 12)
        store.saveList([])

        XCTAssertEqual(store.storedPlanIds(), [7, 12])
    }

    func testTheListComesBackWithoutANetwork() throws {
        let store = try store()
        let summary = TripPlanSummary(id: 3, title: "Beispielreise", legTitles: ["Beispielstadt"],
                                      dayCount: 4, startDate: "2026-06-18",
                                      updatedAt: "2026-06-01T08:00:00.000Z", youOrganise: true)

        store.saveList([summary])
        let kept = store.keptList()

        XCTAssertEqual(kept?.plans.map(\.id), [3])
        XCTAssertEqual(kept?.plans.first?.youOrganise, true)
        XCTAssertNotNil(kept?.storedAt)
    }

    func testATripStoredWithoutAListStillShows() throws {
        // The first flight after the update: bundles, but no list yet.
        let store = try store()
        try store.save(try bundle(), planId: 7)

        let kept = store.keptList()

        XCTAssertEqual(kept?.plans.map(\.id), [7])
        XCTAssertEqual(kept?.plans.first?.displayTitle, "Beispielreise")
        XCTAssertEqual(kept?.plans.first?.dayCount, 1)
        XCTAssertEqual(kept?.plans.first?.startDate, "2026-06-18")
    }

    func testAStoredTripMissingFromTheListIsAdded() throws {
        let store = try store()
        let other = TripPlanSummary(id: 3, title: "Andere Reise", legTitles: [], dayCount: 2,
                                    startDate: nil, updatedAt: "2026-06-01T08:00:00.000Z",
                                    youOrganise: true)
        store.saveList([other])
        try store.save(try bundle(), planId: 7)

        XCTAssertEqual(store.keptList()?.plans.map(\.id), [3, 7])
    }

    func testNothingKeptIsNothingToShow() throws {
        XCTAssertNil(try store().keptList())
    }

    // MARK: - Pictures

    func testAPictureIsKeptAndComesBack() throws {
        let store = try store()
        let url = "https://bilder.beispiel.test/spot-1.jpg"

        store.saveThumb(Data([1, 2, 3]), for: url)

        XCTAssertTrue(store.hasThumb(for: url))
        XCTAssertEqual(store.thumbData(for: url), Data([1, 2, 3]))
    }

    func testAPictureNoStoredTripShowsIsDropped() throws {
        let store = try store()
        let url = "https://bilder.beispiel.test/spot-2.jpg"
        store.saveThumb(Data([4]), for: url)
        try store.save(try bundle(), planId: 7)

        // The example trip has no pictures, so nothing holds this one.
        store.remove(planId: 7)

        XCTAssertFalse(store.hasThumb(for: url))
    }

    // MARK: - Loading by itself

    private func summary(startDate: String?, days: Int = 3) -> TripPlanSummary {
        TripPlanSummary(id: 5, title: "Beispielreise", legTitles: [], dayCount: days,
                        startDate: startDate, updatedAt: "2026-06-01T08:00:00.000Z",
                        youOrganise: true)
    }

    private var utc: TimeZone { TimeZone(secondsFromGMT: 0)! }

    private func day(_ iso: String, hour: Int = 10) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = utc
        let parts = iso.split(separator: "-").compactMap { Int($0) }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: hour))!
    }

    func testATripWithinAWeekComesAlong() {
        XCTAssertTrue(TripOfflineAutoLoad.wants(
            summary(startDate: "2026-06-18"), today: day("2026-06-12"),
            storedAt: nil, declined: false, timeZone: utc))
    }

    func testATripFurtherAwayWaits() {
        XCTAssertFalse(TripOfflineAutoLoad.wants(
            summary(startDate: "2026-06-30"), today: day("2026-06-12"),
            storedAt: nil, declined: false, timeZone: utc))
    }

    func testARunningTripComesAlong() {
        XCTAssertTrue(TripOfflineAutoLoad.wants(
            summary(startDate: "2026-06-11"), today: day("2026-06-12"),
            storedAt: nil, declined: false, timeZone: utc))
    }

    func testAPastOrUndatedTripDoesNot() {
        XCTAssertFalse(TripOfflineAutoLoad.wants(
            summary(startDate: "2026-06-01"), today: day("2026-06-12"),
            storedAt: nil, declined: false, timeZone: utc))
        XCTAssertFalse(TripOfflineAutoLoad.wants(
            summary(startDate: nil), today: day("2026-06-12"),
            storedAt: nil, declined: false, timeZone: utc))
    }

    func testATripDeletedByHandStaysDeleted() {
        XCTAssertFalse(TripOfflineAutoLoad.wants(
            summary(startDate: "2026-06-14"), today: day("2026-06-12"),
            storedAt: nil, declined: true, timeZone: utc))
    }

    func testAFreshCopyIsNotFetchedAgainButAnOldOneIs() {
        let today = day("2026-06-12")
        XCTAssertFalse(TripOfflineAutoLoad.wants(
            summary(startDate: "2026-06-14"), today: today,
            storedAt: today.addingTimeInterval(-3_600), declined: false, timeZone: utc))
        XCTAssertTrue(TripOfflineAutoLoad.wants(
            summary(startDate: "2026-06-14"), today: today,
            storedAt: today.addingTimeInterval(-24 * 3_600), declined: false, timeZone: utc))
    }

    @MainActor
    func testTheRunningTripIsFoundInAKeptList() {
        let plans = [summary(startDate: "2026-06-30"), summary(startDate: "2026-06-11")]

        XCTAssertEqual(TripRunningPlan.running(in: plans, on: day("2026-06-12"))?.startDate, "2026-06-11")
        XCTAssertNil(TripRunningPlan.running(in: plans, on: day("2026-05-01")))
    }

    // MARK: - Ticks without a network

    private func defaults() -> UserDefaults {
        let name = "offline-ticks-\(UUID().uuidString)"
        let store = UserDefaults(suiteName: name)!
        addTeardownBlock { store.removePersistentDomain(forName: name) }
        return store
    }

    func testATickWaitsAndShowsAtOnce() throws {
        let store = defaults()
        let plan = try bundle().plan

        TripTickQueue.append(.status(planId: 7, stopId: 51, status: .done), to: store)
        let shown = TripTickQueue.applied(to: plan, in: store)

        XCTAssertEqual(shown.legs[0].days[0].blocks[0].stops[0].status, "done")
        XCTAssertEqual(TripTickQueue.queuedStopIds(planId: 7, in: store), [51])
    }

    func testTheLastTickOnAStopIsTheOneThatGoes() {
        let store = defaults()

        TripTickQueue.append(.status(planId: 7, stopId: 51, status: .done), to: store)
        TripTickQueue.append(.status(planId: 7, stopId: 51, status: .planned), to: store)

        let ticks = TripTickQueue.load(from: store)
        XCTAssertEqual(ticks.count, 1)
        XCTAssertEqual(ticks.first?.status, "planned")
    }

    func testTicksKeepTheOrderTheyWereTapped() {
        let store = defaults()

        TripTickQueue.append(.status(planId: 7, stopId: 51, status: .done), to: store)
        TripTickQueue.append(.visitAnswer(planId: 7, visitId: 9, confirmed: true, utcOffsetMinutes: 120), to: store)
        TripTickQueue.append(.status(planId: 7, stopId: 52, status: .skipped), to: store)

        XCTAssertEqual(TripTickQueue.load(from: store).map(\.kind), [.status, .visitAnswer, .status])
    }

    func testAnotherTripsTickLeavesThisPlanAlone() throws {
        let store = defaults()
        let plan = try bundle().plan

        TripTickQueue.append(.status(planId: 8, stopId: 51, status: .done), to: store)

        XCTAssertEqual(TripTickQueue.applied(to: plan, in: store).legs[0].days[0].blocks[0].stops[0].status,
                       "planned")
    }

    // MARK: - Documents

    func testADocumentFileIsKeptAndDroppedWithItsTrip() throws {
        let store = try store()
        let withDocument = bundleJSON.replacingOccurrences(
            of: "\"omits\": [\"weather\", \"map\"],",
            with: """
            "omits": ["weather", "map"],
            "documents": [ { "id": 1, "documentId": 33, "role": "ticket", "note": null,
              "linkedBy": "Anna", "readable": true, "title": "Fahrkarte", "sender": null,
              "docDate": null, "hints": [] } ],
            """)
        let decoded = try JSONDecoder().decode(TripOfflineBundle.self, from: Data(withDocument.utf8))
        try store.save(decoded, planId: 7)
        store.saveDocument(Data("%PDF-1.4".utf8), documentId: 33)

        XCTAssertNotNil(store.storedDocument(33))
        XCTAssertEqual(store.load(planId: 7)?.bundle.documents?.first?.title, "Fahrkarte")

        store.remove(planId: 7)

        XCTAssertNil(store.storedDocument(33))
    }

    // MARK: - When it may be used

    func testNoNetworkIsTheCaseItWasWrittenFor() {
        XCTAssertTrue(TripOfflineReach.meansUnreachable(URLError(.notConnectedToInternet)))
        XCTAssertTrue(TripOfflineReach.meansUnreachable(URLError(.timedOut)))
        // The reason §3.9 says "ohne Roaming".
        XCTAssertTrue(TripOfflineReach.meansUnreachable(URLError(.internationalRoamingOff)))
    }

    func testAnAnswerFromTheServerIsNotAnExcuseForTheStoredPlan() {
        // A deleted trip must not live on as a copy on the phone, and
        // "nicht angemeldet" is a thing to fix, not to paper over.
        XCTAssertFalse(TripOfflineReach.meansUnreachable(APIError.httpError(404, nil)))
        XCTAssertFalse(TripOfflineReach.meansUnreachable(APIError.httpError(401, nil)))
        XCTAssertFalse(TripOfflineReach.meansUnreachable(APIError.httpError(500, nil)))
    }

    func testAGatewayThatCannotReachTheAppCounts() {
        // From the phone this is the same situation as no network:
        // nobody is going to answer.
        XCTAssertTrue(TripOfflineReach.meansUnreachable(APIError.httpError(503, nil)))
    }

    // MARK: - Saying how old it is

    func testTodayIsSaidAsToday() {
        var components = DateComponents()
        components.year = 2026
        components.month = 6
        components.day = 18
        components.hour = 9
        components.minute = 14
        var calendar = Calendar(identifier: .gregorian)
        let zone = TimeZone(secondsFromGMT: 0)!
        calendar.timeZone = zone
        let stored = calendar.date(from: components)!

        let text = TripOfflineWording.stamp(
            stored, now: stored.addingTimeInterval(3 * 3_600),
            locale: Locale(identifier: "de_DE"), timeZone: zone)

        XCTAssertEqual(text, "Stand von heute, 09:14")
    }

    func testAnOlderStampCarriesItsDate() {
        var components = DateComponents()
        components.year = 2026
        components.month = 6
        components.day = 15
        components.hour = 20
        components.minute = 5
        var calendar = Calendar(identifier: .gregorian)
        let zone = TimeZone(secondsFromGMT: 0)!
        calendar.timeZone = zone
        let stored = calendar.date(from: components)!

        let text = TripOfflineWording.stamp(
            stored, now: stored.addingTimeInterval(3 * 24 * 3_600),
            locale: Locale(identifier: "de_DE"), timeZone: zone)

        XCTAssertTrue(text.hasPrefix("Stand vom 15."), text)
        XCTAssertTrue(text.hasSuffix("20:05"), text)
    }
}
