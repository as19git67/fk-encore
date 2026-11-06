import XCTest
@testable import F4milCore

/// The URL that opens a web page signed in as the app's user
/// (documentation/plans/assistent-ios.md, stage 5): token and target in the
/// fragment, nothing of either in the path or query.
final class WebHandoverTests: XCTestCase {
    private let server = URL(string: "https://photos.example.test/")!

    func testTokenAndRedirectRideInTheFragment() {
        let url = WebHandover.url(serverURL: server, route: "/finanzen/umsaetze/9", token: "abcDEF123-_")
        XCTAssertEqual(url?.absoluteString, "https://photos.example.test/app/handover#token=abcDEF123-_&redirect=/finanzen/umsaetze/9")
        XCTAssertNil(url?.query)
    }

    func testARouteWithAQueryStaysOneValue() {
        let url = WebHandover.url(serverURL: server, route: "fotos/galerie?photoId=4&x=a+b#top", token: "t0ken-t0ken-t0ken")
        let components = URLComponents(url: url!, resolvingAgainstBaseURL: false)!
        let items = Dictionary(uniqueKeysWithValues: fragmentItems(components).map { ($0.name, $0.value) })
        XCTAssertEqual(items["token"], "t0ken-t0ken-t0ken")
        // The leading slash is added; `&`, `#` and `+` inside survive as themselves.
        XCTAssertEqual(items["redirect"], "/fotos/galerie?photoId=4&x=a+b#top")
        XCTAssertTrue(components.percentEncodedFragment!.contains("%26"))
        XCTAssertTrue(components.percentEncodedFragment!.contains("%2B"))
    }

    func testTheServerOriginLosesItsTrailingSlashes() {
        let url = WebHandover.url(serverURL: URL(string: "http://localhost:4000//")!, route: "/assistent", token: "x")
        XCTAssertEqual(url?.absoluteString, "http://localhost:4000/app/handover#token=x&redirect=/assistent")
    }

    /// Reads the fragment back the way the web page does (`URLSearchParams`).
    private func fragmentItems(_ components: URLComponents) -> [URLQueryItem] {
        var reader = URLComponents()
        reader.percentEncodedQuery = components.percentEncodedFragment
        return reader.queryItems ?? []
    }
}
