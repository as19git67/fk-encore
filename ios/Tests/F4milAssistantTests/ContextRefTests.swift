import XCTest
@testable import F4milAssistant

/// The working set a conversation is created with (`ContextRef` in
/// assistant/briefs.ts), and the first questions it suggests.
final class ContextRefTests: XCTestCase {
    func testARefEncodesAsTheServerReadsIt() throws {
        let data = try JSONEncoder().encode([ContextRef.photo(12), .document(3)])
        let json = try XCTUnwrap(String(data: data, encoding: .utf8))
        XCTAssertTrue(json.contains(#"{"type":"photo","id":12}"#) || json.contains(#"{"id":12,"type":"photo"}"#))
        XCTAssertTrue(json.contains(#""type":"document""#))
    }

    func testTheCapMatchesTheServer() {
        XCTAssertEqual(ContextRef.maxItems, 25)
    }

    func testQuestionsFollowWhatIsInTheWorkingSet() {
        XCTAssertEqual(SuggestedQuestions.questions(aboutContext: []), [])
        let photos = SuggestedQuestions.questions(aboutContext: ["photo"])
        XCTAssertEqual(photos.count, 2)
        XCTAssertTrue(photos.allSatisfy { $0.contains("Fotos") })
        let mixed = SuggestedQuestions.questions(aboutContext: ["photo", "document", "transaction"])
        XCTAssertEqual(mixed.count, 5)
    }
}
