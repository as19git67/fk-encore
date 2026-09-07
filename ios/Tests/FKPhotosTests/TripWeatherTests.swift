import XCTest
@testable import FKPhotosLib

/// The weather as the day and spot cards read it (§7.2).
///
/// The server decides what the sky will do; this side only has to say
/// it without overclaiming. Two things would be wrong quietly: a
/// missing forecast rendered as fine weather, and a shrunken budget
/// shown next to a plan that still holds the full one.
final class TripWeatherTests: XCTestCase {

    /// `feelsLikeC` defaults to the measured temperature, which is what
    /// the server answers below 27 °C: the heat index is not defined
    /// down there and humidity does not make 12 °C feel like 20 °C. A
    /// fixed default here invented a reading the server cannot produce.
    private func weather(
        precipitationMm: Double = 0,
        wetness: String = "dry",
        cloudCover: Int = 20,
        temperatureC: Double = 20,
        feelsLikeC: Double? = nil,
        heat: String = "mild",
        budgetFactor: Double = 1,
    ) -> TripBlockWeather {
        TripBlockWeather(
            precipitationMm: precipitationMm, wetness: wetness, cloudCover: cloudCover,
            temperatureC: temperatureC, feelsLikeC: feelsLikeC ?? temperatureC, heat: heat,
            budgetFactor: budgetFactor)
    }

    func testTheOneLineADayCardHasRoomFor() {
        XCTAssertEqual(weather(temperatureC: 23.6).summary, "24° · trocken")
        XCTAssertEqual(weather(wetness: "wet", temperatureC: 12).summary, "12° · nass")
    }

    func testTheFeltTemperatureIsNamedOnlyWhenItDiffers() {
        // "28° (gefühlt 28°)" is noise on a line that has room for one
        // fact.
        XCTAssertFalse(weather(temperatureC: 28, feelsLikeC: 28).summary.contains("gefühlt"))
        XCTAssertTrue(weather(temperatureC: 33, feelsLikeC: 41).summary.contains("gefühlt 41°"))
    }

    func testTheBudgetSentenceAppearsOnlyWhenTheWeatherCostsSomething() {
        XCTAssertNil(weather(budgetFactor: 1).budgetSentence)
        let wet = weather(wetness: "wet", budgetFactor: 0.75)
        XCTAssertEqual(wet.budgetSentence?.contains("25 %"), true)
    }

    func testHeatAndRainAreNamedTogetherWhenBothBite() {
        let both = weather(wetness: "wet", heat: "hot", budgetFactor: 0.6)
        XCTAssertEqual(both.budgetSentence?.contains("Hitze und Nässe"), true)
        let justHeat = weather(heat: "hot", budgetFactor: 0.8)
        XCTAssertEqual(justHeat.budgetSentence?.contains("Hitze"), true)
        XCTAssertEqual(justHeat.budgetSentence?.contains("Nässe"), false)
    }

    func testACloudySkyDoesNotWearTheSunIcon() {
        XCTAssertEqual(weather(cloudCover: 90).symbolName, "cloud")
        XCTAssertEqual(weather(cloudCover: 10).symbolName, "sun.max")
        XCTAssertEqual(weather(wetness: "wet").symbolName, "cloud.rain")
    }

    func testShelterReadsAsGermanForEveryValue() {
        for value in ["indoor", "partly", "outdoor"] {
            let shelter = TripSpotShelter(osmRef: "way:1", shelter: value)
            XCTAssertFalse(shelter.label.isEmpty)
            XCTAssertNotEqual(shelter.label, value)
        }
        // A value this build has not learned about still has to read as
        // a sentence, not as an identifier.
        XCTAssertNotEqual(TripSpotShelter(osmRef: "way:1", shelter: "cave").label, "cave")
    }

    func testAMissingForecastIsNotFineWeather() throws {
        // The whole point of `available`: "we do not know" and "it will
        // be dry" are different statements (§15.3).
        let json = """
        {"day":"2026-09-08","available":false,"overall":null,
         "blocks":[{"blockId":"morning","label":"Vormittag","weather":null}],"spots":[]}
        """
        let decoded = try JSONDecoder().decode(TripDayForecast.self, from: Data(json.utf8))

        XCTAssertFalse(decoded.available)
        XCTAssertNil(decoded.overall)
        XCTAssertNil(decoded.weather(forBlock: "morning"))
    }

    func testWeatherAndShelterAreFoundByTheirKeyNotByPosition() throws {
        let json = """
        {"day":"2026-09-08","available":true,"overall":null,
         "blocks":[{"blockId":"morning","label":"Vormittag","weather":null},
                   {"blockId":"afternoon","label":"Nachmittag",
                    "weather":{"precipitationMm":3.0,"wetness":"wet","cloudCover":95,
                               "temperatureC":14.0,"feelsLikeC":14.0,"heat":"mild",
                               "budgetFactor":0.75}}],
         "spots":[{"osmRef":"way:1","shelter":"indoor"},
                  {"osmRef":"way:2","shelter":"outdoor"}]}
        """
        let decoded = try JSONDecoder().decode(TripDayForecast.self, from: Data(json.utf8))

        XCTAssertEqual(decoded.weather(forBlock: "afternoon")?.wetness, "wet")
        XCTAssertNil(decoded.weather(forBlock: "evening"))
        XCTAssertEqual(decoded.shelter(for: "way:2")?.shelter, "outdoor")
        XCTAssertNil(decoded.shelter(for: "way:99"))
    }
}
