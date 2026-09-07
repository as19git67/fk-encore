import XCTest
@testable import FKPhotosLib

/// The light hint as the spot card reads it (§7.3).
///
/// The server decides when the light is good; this side only has to
/// say it without promising more than was measured. Two things are
/// easy to get wrong here and neither would fail loudly: a window
/// rendered in the wrong clock, and a sentence that claims to know
/// which face of a building is lit — which an outline cannot tell.
final class TripLightHintTests: XCTestCase {

    private func window(kind: String, from: Int, to: Int) -> TripLightWindow {
        TripLightWindow(kind: kind, fromMinutes: from, toMinutes: to)
    }

    func testAWindowReadsAsAClockRange() {
        let golden = window(kind: "golden", from: 20 * 60 + 29, to: 21 * 60 + 42)
        XCTAssertEqual(golden.range, "20:29–21:42")
        XCTAssertEqual(golden.label, "Goldene Stunde")
    }

    func testEachKindHasItsOwnWords() {
        XCTAssertEqual(window(kind: "blue", from: 0, to: 1).label, "Blaue Stunde")
        XCTAssertEqual(window(kind: "harsh", from: 0, to: 1).label, "Hohe Mittagssonne")
        // A kind this build has not learned about still has to read as
        // German rather than as its identifier.
        XCTAssertFalse(window(kind: "whatever", from: 0, to: 1).label.isEmpty)
        XCTAssertNotEqual(window(kind: "whatever", from: 0, to: 1).label, "whatever")
    }

    func testTheFacadeSentenceNeverNamesAFaceItCannotKnow() {
        // The azimuth is folded into [0, 180) because an outline cannot
        // say which of the two long faces is the front. The sentence
        // must not quietly pick one.
        let frontal = TripSpotLight(osmRef: "way:1", best: nil, facade: "frontal")
        let sentence = try? XCTUnwrap(frontal.facadeSentence)
        XCTAssertNotNil(sentence)
        XCTAssertTrue(frontal.facadeSentence?.contains("eine der beiden") == true)
        for wrong in ["Westfassade", "Ostfassade", "Nordseite", "Südseite"] {
            XCTAssertFalse(frontal.facadeSentence?.contains(wrong) == true,
                           "the sentence claims \(wrong), which the data cannot support")
        }
    }

    func testEveryKnownVerdictSaysSomethingAndAnUnknownOneSaysNothing() {
        for verdict in ["frontal", "raking", "edge_on"] {
            let hint = TripSpotLight(osmRef: "way:1", best: nil, facade: verdict)
            XCTAssertNotNil(hint.facadeSentence, "\(verdict) has no wording")
        }
        // Most spots are nodes with no outline at all. Silence is the
        // right answer, not a hedge.
        XCTAssertNil(TripSpotLight(osmRef: "node:1", best: nil, facade: nil).facadeSentence)
    }

    func testTheHintIsFoundByItsSpotAndNotByPosition() {
        let day = TripDayLight(
            day: "2026-06-21",
            windows: [],
            spots: [
                TripSpotLight(osmRef: "node:1", best: window(kind: "golden", from: 1, to: 2),
                              facade: nil),
                TripSpotLight(osmRef: "way:20", best: window(kind: "blue", from: 3, to: 4),
                              facade: "frontal"),
            ],
        )
        XCTAssertEqual(day.hint(for: "way:20")?.facade, "frontal")
        XCTAssertNil(day.hint(for: "node:99"))
    }

    func testATripWithoutDatesDecodesAsHavingNothingToSay() throws {
        // The server answers day: null rather than today's sun. A
        // decoding failure here would take the whole day plan with it.
        let json = """
        {"day":null,"windows":[],"spots":[]}
        """
        let decoded = try JSONDecoder().decode(TripDayLight.self, from: Data(json.utf8))
        XCTAssertNil(decoded.day)
        XCTAssertTrue(decoded.spots.isEmpty)
    }

    func testAnOlderServerWithoutTheFacadeFieldStillDecodes() throws {
        let json = """
        {"osmRef":"node:1","best":{"kind":"golden","fromMinutes":1229,"toMinutes":1302}}
        """
        let decoded = try JSONDecoder().decode(TripSpotLight.self, from: Data(json.utf8))
        XCTAssertNil(decoded.facade)
        XCTAssertEqual(decoded.best?.range, "20:29–21:42")
    }
}
