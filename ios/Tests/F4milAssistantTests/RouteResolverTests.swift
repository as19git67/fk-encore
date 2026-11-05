import XCTest
@testable import F4milAssistant

/// Where a row leads when the app does not take it.
final class RouteResolverTests: XCTestCase {
    func testADocumentIsItsPDF() {
        XCTAssertEqual(RouteResolver.target(for: "/dokumente/123"), .documentPDF(id: 123))
        XCTAssertEqual(RouteResolver.target(for: "/dokumente/123?seite=2"), .documentPDF(id: 123))
    }

    func testEverythingElseIsAPage() {
        XCTAssertEqual(RouteResolver.target(for: "/dokumente/mappen/3"), .web)
        XCTAssertEqual(RouteResolver.target(for: "/dokumente"), .web)
        XCTAssertEqual(RouteResolver.target(for: "/finanzen/umsaetze/9"), .web)
        XCTAssertEqual(RouteResolver.target(for: "/fotos/galerie?photoId=4"), .web)
    }

    func testTheWebURLIsTheAppUnderTheServer() {
        let server = URL(string: "https://example.test/")!
        XCTAssertEqual(
            RouteResolver.webURL(for: "/finanzen/umsaetze/9", serverURL: server)?.absoluteString,
            "https://example.test/app/finanzen/umsaetze/9"
        )
        XCTAssertEqual(
            RouteResolver.webURL(for: "fotos/galerie?photoId=4", serverURL: URL(string: "http://localhost:4000")!)?.absoluteString,
            "http://localhost:4000/app/fotos/galerie?photoId=4"
        )
    }
}
