import XCTest
@testable import FKPhotosLib

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
                        "travelFromPrevious": null }
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

        XCTAssertEqual(bundle.light(legIndex: 0, dayIndex: 0)?.day, "2026-06-18")
        XCTAssertNil(bundle.light(legIndex: 0, dayIndex: 1))
        XCTAssertNil(bundle.light(legIndex: 1, dayIndex: 0))
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
