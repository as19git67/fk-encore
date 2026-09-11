import XCTest
@testable import FKPhotosLib

/// The outing a collection proposes (§20.2, §20.3).
///
/// Three things are worth pinning down, and none of them is the plan:
/// an afternoon is told in hours, a refusal says *which* refusal it is,
/// and a day that came out shorter than somebody wanted says so.
final class TripIdeasOutingTests: XCTestCase {

    private func proposal(_ json: String) throws -> TripOutingProposal {
        try JSONDecoder().decode(TripOutingProposal.self, from: Data(json.utf8))
    }

    private func offered(used: Int, budget: Int = 240, leftOut: Int = 0) throws -> TripOutingProposal {
        try proposal("""
        { "offered": true, "reason": "ok", "stops": [], "usedMinutes": \(used),
          "budgetMinutes": \(budget), "leftOut": \(leftOut) }
        """)
    }

    // MARK: - An afternoon is hours

    func testMinutesUnderAnHourStayMinutes() {
        XCTAssertEqual(TripOutingProposal.duration(45), "45 Min.")
    }

    func testWholeHoursHaveNoRemainder() {
        XCTAssertEqual(TripOutingProposal.duration(120), "2 h")
    }

    func testHoursAndMinutesReadAsAClock() {
        // "135 Minuten" is a number to convert; "2 h 15" is an
        // afternoon you can picture.
        XCTAssertEqual(TripOutingProposal.duration(135), "2 h 15")
    }

    // MARK: - The summary

    func testTheSummarySaysWhatItUsesOfWhat() throws {
        XCTAssertEqual(try offered(used: 195).summary, "3 h 15 von 4 h")
    }

    func testOneLeftOutIdeaIsSingular() throws {
        XCTAssertEqual(
            try offered(used: 195, leftOut: 1).summary,
            "3 h 15 von 4 h · eine Idee bleibt liegen",
        )
    }

    func testSeveralLeftOutIdeasAreCounted() throws {
        XCTAssertEqual(
            try offered(used: 195, leftOut: 3).summary,
            "3 h 15 von 4 h · 3 Ideen bleiben liegen",
        )
    }

    func testAFittingProposalSaysNothingAboutLeftovers() throws {
        XCTAssertFalse(try offered(used: 240).summary.contains("liegen"))
    }

    // MARK: - The two refusals mean different things

    func testNothingCollectedNearbyIsItsOwnAnswer() throws {
        let refusal = try proposal("""
        { "offered": false, "reason": "no-ideas", "stops": [],
          "usedMinutes": 0, "budgetMinutes": 240, "leftOut": 0 }
        """).refusal
        XCTAssertEqual(refusal?.contains("nichts aus eurem Vorrat"), true)
    }

    func testTooLittleTimeIsADifferentAnswer() throws {
        // Sharing one sentence would hide which of the two it is: an
        // empty collection here, or a budget too small for what is.
        let refusal = try proposal("""
        { "offered": false, "reason": "nothing-fits", "stops": [],
          "usedMinutes": 0, "budgetMinutes": 60, "leftOut": 2 }
        """).refusal
        XCTAssertEqual(refusal?.contains("passt nicht in die Zeit"), true)
    }

    func testAnOfferedProposalRefusesNothing() throws {
        XCTAssertNil(try offered(used: 200).refusal)
    }

    // MARK: - What accepting says

    private func accepted(planned: [Int], inPool: [Int]) -> TripOutingAcceptResponse {
        TripOutingAcceptResponse(plan: .init(id: 7), planned: planned, inPool: inPool)
    }

    func testADayThatTookEverythingSaysSoPlainly() {
        XCTAssertEqual(
            accepted(planned: [1, 2], inPool: []).sentence,
            "Der Ausflug steht als Reise.",
        )
    }

    func testWhatDidNotFitIsSaidRatherThanDropped() {
        // §5: the outing that fits is shorter than the one somebody
        // wanted, and silence about the difference is how a plan loses
        // an idea without anybody noticing.
        XCTAssertEqual(
            accepted(planned: [1], inPool: [2]).sentence,
            "Der Ausflug steht als Reise — eine Idee liegt im Vorrat der Reise.",
        )
        XCTAssertEqual(
            accepted(planned: [1], inPool: [2, 3]).sentence,
            "Der Ausflug steht als Reise — 2 Ideen liegen im Vorrat der Reise.",
        )
    }

    // MARK: - The day is a calendar day

    func testTheDateIsTheLocalDayNotAUtcSlice() {
        // The same trap `toLocalIsoDate` exists for on the web side: an
        // instant sliced in UTC books the outing for yesterday east of
        // Greenwich.
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Berlin")!
        // 2026-05-04 00:30 local is 2026-05-03 22:30 UTC.
        let date = calendar.date(from: DateComponents(year: 2026, month: 5, day: 4, hour: 0, minute: 30))!
        XCTAssertEqual(TripIdeasOutingView.isoDay(date, calendar: calendar), "2026-05-04")
    }

    func testTheOutingAsksWithADayTripRadiusAndHalfADay() {
        // Half an hour in the car is the way to the lake, not a detour
        // (§20.2) — so this is not the 5 km the nearby screen uses.
        XCTAssertEqual(TripIdeaDefaults.outingRadiusM, 25_000)
        XCTAssertEqual(TripIdeaDefaults.outingBudgetMinutes, 240)
    }
}
