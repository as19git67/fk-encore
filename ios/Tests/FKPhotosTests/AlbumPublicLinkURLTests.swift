import XCTest
@testable import FKPhotosLib

/// The public album link is the one URL the app hands to people who do not have
/// an account, so pointing it at the wrong path is invisible locally and broken
/// for every recipient. These cover the shape of what gets shared.
final class AlbumPublicLinkURLTests: XCTestCase {

    // MARK: - The shape recipients get

    func testBuildsTheSPARouteNotTheAPIEndpoint() {
        let url = AlbumPublicLinkURL.make(
            serverURL: "https://f4mil.example",
            token: "abc123"
        )
        XCTAssertEqual(url, "https://f4mil.example/app/albums/shared/abc123")
    }

    /// `/albums/public/<token>` is the JSON API. A recipient opening that sees a
    /// raw document, so it must never be what we share.
    func testDoesNotUseTheJSONAPIPath() {
        let url = AlbumPublicLinkURL.make(serverURL: "https://f4mil.example", token: "abc123")
        XCTAssertNotNil(url)
        XCTAssertFalse(url!.contains("/albums/public/"))
    }

    /// web/static.ts builds this exact string as its canonical `pageUrl` before
    /// injecting the Open Graph tags. Drifting from it loses link previews.
    func testMatchesTheServerSideCanonicalPageURL() {
        let token = "sharetoken"
        let origin = "https://f4mil.example"
        let serverSidePageURL = "\(origin)/app/albums/shared/\(token)"
        XCTAssertEqual(AlbumPublicLinkURL.make(serverURL: origin, token: token), serverSidePageURL)
    }

    // MARK: - Server URL normalisation

    func testTrailingSlashDoesNotProduceADoubleSlash() {
        let url = AlbumPublicLinkURL.make(serverURL: "https://f4mil.example/", token: "abc123")
        XCTAssertEqual(url, "https://f4mil.example/app/albums/shared/abc123")
    }

    func testMultipleTrailingSlashesAreCollapsed() {
        let url = AlbumPublicLinkURL.make(serverURL: "https://f4mil.example///", token: "abc123")
        XCTAssertEqual(url, "https://f4mil.example/app/albums/shared/abc123")
    }

    func testSurroundingWhitespaceIsIgnored() {
        let url = AlbumPublicLinkURL.make(serverURL: "  https://f4mil.example  ", token: "abc123")
        XCTAssertEqual(url, "https://f4mil.example/app/albums/shared/abc123")
    }

    func testPortAndLocalhostArePreserved() {
        let url = AlbumPublicLinkURL.make(serverURL: "http://localhost:4000", token: "abc123")
        XCTAssertEqual(url, "http://localhost:4000/app/albums/shared/abc123")
    }

    // MARK: - Nothing worth sharing

    func testBlankServerURLYieldsNoLink() {
        XCTAssertNil(AlbumPublicLinkURL.make(serverURL: "", token: "abc123"))
        XCTAssertNil(AlbumPublicLinkURL.make(serverURL: "   ", token: "abc123"))
    }

    func testEmptyTokenYieldsNoLink() {
        XCTAssertNil(AlbumPublicLinkURL.make(serverURL: "https://f4mil.example", token: ""))
    }

    /// A slash-only server URL normalises to empty and must not yield a
    /// host-less "/app/albums/shared/…" that silently fails for recipients.
    func testSlashOnlyServerURLYieldsNoLink() {
        XCTAssertNil(AlbumPublicLinkURL.make(serverURL: "/", token: "abc123"))
    }

    // MARK: - Usable as a URL

    /// ShareLink hands a URL to iMessage to get the Open Graph preview, so the
    /// built string has to actually parse.
    func testResultParsesAsAURL() {
        let url = AlbumPublicLinkURL.make(serverURL: "https://f4mil.example", token: "abc123")
        XCTAssertNotNil(url.flatMap(URL.init(string:)))
    }
}
