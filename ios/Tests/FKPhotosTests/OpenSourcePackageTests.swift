import XCTest
@testable import FKPhotosLib

/// The "Open-Source-Software" list on Quellen & Lizenzen names the version
/// that is actually built in. A Dependabot bump of `Package.resolved` that
/// leaves the list behind fails here instead of in an App Store review.
final class OpenSourcePackageTests: XCTestCase {

    private struct Resolved: Decodable {
        struct Pin: Decodable {
            struct State: Decodable { let version: String? }
            let identity: String
            let state: State
        }
        let pins: [Pin]
    }

    func testListedVersionsMatchPackageResolved() throws {
        let ios = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // → ios/Tests/FKPhotosTests
            .deletingLastPathComponent()   // → ios/Tests
            .deletingLastPathComponent()   // → ios
        let data = try Data(contentsOf: ios.appending(path: "Package.resolved"))
        let pins = try JSONDecoder().decode(Resolved.self, from: data).pins
        let versions = Dictionary(uniqueKeysWithValues: pins.map { ($0.identity, $0.state.version) })

        for pkg in OpenSourcePackage.all {
            XCTAssertEqual(versions[pkg.name] ?? nil, pkg.version,
                           "\(pkg.name): Version in SourcesView.swift an Package.resolved angleichen")
        }
    }

    func testEveryNoticeAndTheLicenceAreBundled() {
        for resource in OpenSourcePackage.all.map(\.noticeResource) + ["Apache-2.0"] {
            XCTAssertNotNil(OpenSourcePackage.bundledText(resource),
                            "\(resource).txt fehlt in Resources/Licenses")
        }
    }
}
