import XCTest
@testable import FKPhotosLib

/// iOS album titles keep whatever the user typed, the web app trims before it
/// creates an album. Matching untrimmed made "Urlaub " miss the server's
/// "Urlaub" and the sync created a duplicate album (issue #849).
final class AlbumNameMatchingTests: XCTestCase {

    func testNormalizedTrimsSurroundingWhitespace() {
        XCTAssertEqual(AlbumName.normalized("Urlaub "), "Urlaub")
        XCTAssertEqual(AlbumName.normalized(" Urlaub"), "Urlaub")
        XCTAssertEqual(AlbumName.normalized("\tUrlaub\n"), "Urlaub")
        XCTAssertEqual(AlbumName.normalized("Urlaub"), "Urlaub")
    }

    func testNormalizedKeepsInnerWhitespace() {
        XCTAssertEqual(AlbumName.normalized(" Gardasee 2026 "), "Gardasee 2026")
    }

    func testTrailingSpaceMatchesTrimmedName() {
        XCTAssertTrue(AlbumName.matches("Urlaub ", "Urlaub"))
        XCTAssertTrue(AlbumName.matches("Urlaub", "Urlaub "))
        XCTAssertTrue(AlbumName.matches(" Urlaub ", "\tUrlaub"))
    }

    func testDifferentNamesStillDiffer() {
        XCTAssertFalse(AlbumName.matches("Urlaub", "Urlaub 2026"))
        // Case is signal, not noise — two differently capitalised albums stay
        // two albums.
        XCTAssertFalse(AlbumName.matches("urlaub", "Urlaub"))
        XCTAssertFalse(AlbumName.matches("Urla ub", "Urlaub"))
    }
}
