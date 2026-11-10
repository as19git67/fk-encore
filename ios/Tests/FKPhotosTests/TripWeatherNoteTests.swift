import XCTest
@testable import FKPhotosLib

/// The weather note of a stay (reise-planen-und-unterwegs.md, stage 7, step 1).
final class TripWeatherNoteTests: XCTestCase {
    private let json = """
    {"notes":[{"dayIndex":1,"wetness":2,"rainFromMinutes":660,"temperatureC":13,
      "outdoor":[{"osmRef":"node:1","name":"Hafenrunde"},{"osmRef":"node:2","name":"Aussichtsturm"}],
      "drierDayIndex":2,"drierWetness":0,
      "swap":{"withDayIndex":2,"gets":[{"osmRef":"node:3","name":"Museum"}],
              "gives":[{"osmRef":"node:1","name":"Hafenrunde"}],
              "stays":[{"osmRef":"node:4","name":"Führung","dayIndex":1,"because":"Ticket 14:00"}]},
      "outdoorMove":{"toDayIndex":2,"moves":[{"osmRef":"node:1","name":"Hafenrunde"}]}}],
     "degraded":false}
    """

    func testTheNotesDecode() throws {
        let response = try JSONDecoder().decode(TripWeatherNotesResponse.self, from: Data(json.utf8))
        let note = try XCTUnwrap(response.notes.first)
        XCTAssertEqual(note.id, 1)
        XCTAssertEqual(note.swap?.stays.first?.because, "Ticket 14:00")
        XCTAssertEqual(note.outdoorMove?.toDayIndex, 2)
    }

    func testTheTitleCountsTheSpotsOutdoors() throws {
        let note = try XCTUnwrap(JSONDecoder().decode(TripWeatherNotesResponse.self, from: Data(json.utf8)).notes.first)
        XCTAssertEqual(TripWeatherText.title(note), "Regen an einem Tag mit 2 Spots draußen")
        XCTAssertEqual(TripWeatherText.names([]), "nichts")
        XCTAssertEqual(TripWeatherText.names(note.outdoor), "Hafenrunde, Aussichtsturm")
    }
}
