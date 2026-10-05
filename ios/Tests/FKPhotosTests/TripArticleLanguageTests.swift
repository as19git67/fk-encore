import XCTest
@testable import FKPhotosLib

/// Which language a Wikipedia article is in, read out of its address
/// (§10.4).
final class TripArticleLanguageTests: XCTestCase {

    private func url(_ text: String) throws -> URL {
        try XCTUnwrap(URL(string: text))
    }

    func testTheLanguageIsTheFirstPartOfTheHost() throws {
        XCTAssertEqual(TripArticleLanguage.code(of: try url(
            "https://it.wikipedia.org/wiki/Colosseo")), "it")
        XCTAssertEqual(TripArticleLanguage.code(of: try url(
            "https://pt.m.wikipedia.org/wiki/Mosteiro")), "pt")
    }

    func testTheGermanArticleSaysNothing() throws {
        // The point of this is the warning, and "(Deutsch)" on a German
        // screen is noise.
        XCTAssertNil(TripArticleLanguage.name(of: try url(
            "https://de.wikipedia.org/wiki/Kolosseum")))
    }

    func testAForeignArticleIsNamedInGerman() throws {
        // On a German device the system word for "it" is "Italienisch".
        let name = TripArticleLanguage.name(of: try url(
            "https://it.wikipedia.org/wiki/Colosseo"))
        XCTAssertEqual(name, Locale.current.localizedString(forLanguageCode: "it"))
        XCTAssertNotNil(name)
    }

    func testSomethingThatIsNotAnArticleSaysNothing() throws {
        XCTAssertNil(TripArticleLanguage.code(of: try url("https://example.test/wiki/X")))
        XCTAssertNil(TripArticleLanguage.code(of: try url("https://www.wikipedia.org/")))
        XCTAssertNil(TripArticleLanguage.code(of: try url("https://wikipedia.org/wiki/X")))
    }

    // MARK: - The languages not to translate (§25, stage C)

    func testTheKeptLanguagesAreCodesOnlyAndNeverGerman() {
        XCTAssertEqual(TripArticlePreferences.codes(from: "en, IT,,pt-br, nonsense!, de, en"),
                       ["en", "it", "pt-br"])
        XCTAssertEqual(TripArticlePreferences.stored(from: ["en", "it"]), "en,it")
        XCTAssertEqual(TripArticlePreferences.codes(from: ""), [])
    }

    func testTheOfferedLanguagesHaveNamesAndNoGerman() {
        XCTAssertFalse(TripArticlePreferences.offeredCodes.contains("de"))
        XCTAssertEqual(Set(TripArticlePreferences.offeredCodes).count, TripArticlePreferences.offeredCodes.count)
    }

    func testTheFetchedDateReadsBothTimestampShapes() {
        XCTAssertNotNil(TripSpotArticle.parseTimestamp("2026-10-05T08:00:00.123Z"))
        XCTAssertNotNil(TripSpotArticle.parseTimestamp("2026-10-05T08:00:00Z"))
        XCTAssertNil(TripSpotArticle.parseTimestamp("gestern"))
    }
}
