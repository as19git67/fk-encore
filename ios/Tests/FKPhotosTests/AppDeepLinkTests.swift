import XCTest
@testable import FKPhotosLib

/// Parsing deep links (#768 §5a) — the one table every „open X" source
/// (notification, widget, Spotlight, shared link) has to agree with.
final class AppDeepLinkTests: XCTestCase {

    private let server = URL(string: "https://photos.example.test")!

    // MARK: - App scheme

    func testTheCanonicalReviewQueueFormParses() {
        let url = URL(string: "f4milphotos://review-queue")!
        XCTAssertEqual(AppDeepLink.parse(url), .reviewQueue)
    }

    func testAPathFormAlsoParses() {
        let url = URL(string: "f4milphotos:/review-queue")!
        XCTAssertEqual(AppDeepLink.parse(url), .reviewQueue)
    }

    func testCaseDoesNotMatter() {
        let url = URL(string: "F4milPhotos://Review-Queue")!
        XCTAssertEqual(AppDeepLink.parse(url), .reviewQueue)
    }

    func testAnUnknownHostUnderTheRightSchemeIsRejected() {
        let url = URL(string: "f4milphotos://something-else")!
        XCTAssertNil(AppDeepLink.parse(url))
    }

    func testEntityLinksCarryTheirId() {
        XCTAssertEqual(AppDeepLink.parse(URL(string: "f4milphotos://album/12")!), .album(id: 12))
        XCTAssertEqual(AppDeepLink.parse(URL(string: "f4milphotos://photo/34")!), .photo(id: 34))
        XCTAssertEqual(AppDeepLink.parse(URL(string: "f4milphotos://person/5")!), .person(id: 5))
        XCTAssertEqual(AppDeepLink.parse(URL(string: "f4milphotos://recap/7")!), .recap(id: 7))
        XCTAssertEqual(AppDeepLink.parse(URL(string: "f4milphotos://recaps")!), .recaps)
        XCTAssertEqual(AppDeepLink.parse(URL(string: "f4milphotos://feed")!), .feed)
        XCTAssertEqual(
            AppDeepLink.parse(URL(string: "f4milphotos://shared-album/abc_DEF-123")!),
            .sharedAlbum(token: "abc_DEF-123")
        )
    }

    func testASearchLinkCarriesItsQuery() {
        XCTAssertEqual(
            AppDeepLink.parse(URL(string: "f4milphotos://search?q=Kirchen%20in%20M%C3%BCnchen")!),
            .search(query: "Kirchen in München")
        )
        XCTAssertNil(AppDeepLink.parse(URL(string: "f4milphotos://search")!))
        XCTAssertNil(AppDeepLink.parse(URL(string: "f4milphotos://search?q=%20")!))
    }

    func testASearchLinkRoundTripsAndHasNoWebForm() {
        let link = AppDeepLink.search(query: "Kirchen in München 2004")
        XCTAssertEqual(AppDeepLink.parse(AppDeepLink.url(for: link)), link)
        XCTAssertNil(AppDeepLink.webURL(for: link, serverURL: server))
    }

    func testANonNumericIdIsRejected() {
        XCTAssertNil(AppDeepLink.parse(URL(string: "f4milphotos://album/twelve")!))
        XCTAssertNil(AppDeepLink.parse(URL(string: "f4milphotos://album")!))
    }

    func testATokenWithForeignCharactersIsRejected() {
        XCTAssertNil(AppDeepLink.parse(URL(string: "f4milphotos://shared-album/a%2Fb")!))
    }

    /// What the notification actually posts — round-tripped, so a change to
    /// one side cannot silently stop matching the other.
    func testTheGeneratedURLsParseBackToThemselves() {
        let links: [AppDeepLink] = [
            .reviewQueue, .album(id: 1), .sharedAlbum(token: "tok-1"), .photo(id: 2),
            .person(id: 3), .recap(id: 4), .recaps, .feed,
        ]
        for link in links {
            XCTAssertEqual(AppDeepLink.parse(AppDeepLink.url(for: link)), link)
        }
        XCTAssertEqual(AppDeepLink.parse(AppDeepLink.reviewQueueURL), .reviewQueue)
    }

    // MARK: - Web URLs (universal links)

    func testTheWebRoutesMapOntoTheSameTargets() {
        func parse(_ s: String) -> AppDeepLink? {
            AppDeepLink.parse(URL(string: "https://photos.example.test" + s)!, serverURL: server)
        }
        XCTAssertEqual(parse("/app/fotos/alben/12"), .album(id: 12))
        XCTAssertEqual(parse("/app/albums/12"), .album(id: 12))
        XCTAssertEqual(parse("/app/albums/shared/abc-DEF_1"), .sharedAlbum(token: "abc-DEF_1"))
        XCTAssertEqual(parse("/app/fotos/personen?personId=5"), .person(id: 5))
        XCTAssertEqual(parse("/app/fotos/rueckblicke"), .recaps)
        XCTAssertEqual(parse("/app/fotos/rueckblicke?recapId=7"), .recap(id: 7))
        XCTAssertEqual(parse("/app/fotos/feed"), .feed)
        XCTAssertEqual(parse("/app/fotos/review-queue"), .reviewQueue)
        XCTAssertEqual(parse("/app/fotos/galerie?photoId=34"), .photo(id: 34))
        XCTAssertEqual(parse("/app/photos?photoId=34"), .photo(id: 34))
    }

    func testWebRoutesWithoutAnInAppTargetAreLeftToTheBrowser() {
        func parse(_ s: String) -> AppDeepLink? {
            AppDeepLink.parse(URL(string: "https://photos.example.test" + s)!, serverURL: server)
        }
        XCTAssertNil(parse("/app/fotos/galerie"))
        XCTAssertNil(parse("/app/fotos/personen"))
        XCTAssertNil(parse("/app/dokumente/korb"))
        XCTAssertNil(parse("/app/finanzen"))
        XCTAssertNil(parse("/app/"))
        XCTAssertNil(parse("/albums/public/abc"))
    }

    func testAWebURLOnAnotherHostIsRejected() {
        let url = URL(string: "https://elsewhere.example.test/app/fotos/alben/12")!
        XCTAssertNil(AppDeepLink.parse(url, serverURL: server))
    }

    func testAWebURLWithoutAConfiguredServerIsRejected() {
        let url = URL(string: "https://photos.example.test/app/fotos/alben/12")!
        XCTAssertNil(AppDeepLink.parse(url, serverURL: nil))
    }

    func testTheServerHostComparisonIgnoresCase() {
        let url = URL(string: "https://Photos.Example.Test/app/fotos/alben/12")!
        XCTAssertEqual(AppDeepLink.parse(url, serverURL: server), .album(id: 12))
    }

    func testAnotherSchemeIsRejected() {
        XCTAssertNil(AppDeepLink.parse(URL(string: "mailto:review-queue")!))
    }

    // MARK: - Web URLs the app generates

    func testTheGeneratedWebURLsParseBackToThemselves() {
        let links: [AppDeepLink] = [
            .reviewQueue, .album(id: 1), .sharedAlbum(token: "tok-1"), .photo(id: 2),
            .person(id: 3), .recap(id: 4), .recaps, .feed,
        ]
        for link in links {
            let url = AppDeepLink.webURL(for: link, serverURL: server)
            XCTAssertNotNil(url, "\(link)")
            XCTAssertEqual(AppDeepLink.parse(url!, serverURL: server), link)
        }
    }

    func testTheSharedAlbumWebURLMatchesWhatTheShareSheetHandsOut() {
        let generated = AppDeepLink.webURL(for: .sharedAlbum(token: "tok"), serverURL: server)?.absoluteString
        XCTAssertEqual(generated, AlbumPublicLinkURL.make(serverURL: server.absoluteString, token: "tok"))
    }

    func testAServerURLWithATrailingSlashDoesNotDoubleTheSlash() {
        let url = AppDeepLink.webURL(for: .feed, serverURL: URL(string: "https://photos.example.test/")!)
        XCTAssertEqual(url?.absoluteString, "https://photos.example.test/app/fotos/feed")
    }
}
