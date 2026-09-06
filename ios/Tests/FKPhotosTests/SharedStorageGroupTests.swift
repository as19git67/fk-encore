import XCTest
@testable import FKPhotosLib

/// The App Group the code names has to be one the targets are signed for.
///
/// This is the failure that started these tests. Both entitlements files
/// granted `group.de.f4mil.photos`; every line of code asked for
/// `group.dev.fk-encore.F4milPhotos`. Nothing anywhere said so, because
/// `UserDefaults(suiteName:)` does not fail on a group the process has
/// no entitlement for — it returns a defaults object backed by a plist
/// inside that process's own sandbox. The app wrote its token, the
/// extension read and found nothing, and the extension's honest report
/// was "F4mil ist nicht eingerichtet. Bitte öffne die App und melde
/// dich an." to somebody who was very much logged in.
///
/// Reading the entitlements as files, the way the payload-copy test
/// reads both copies of its struct: the signed value is the truth here,
/// and a constant that disagrees with it is broken however good it
/// looks.
final class SharedStorageGroupTests: XCTestCase {

    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // → ios/Tests/FKPhotosTests
            .deletingLastPathComponent()   // → ios/Tests
            .deletingLastPathComponent()   // → ios
    }

    private func appGroups(inEntitlementsAt path: String) throws -> [String] {
        let url = iosRoot.appending(path: path)
        let data = try Data(contentsOf: url)
        let plist = try PropertyListSerialization.propertyList(
            from: data, format: nil) as? [String: Any]
        let groups = plist?["com.apple.security.application-groups"] as? [String]
        return try XCTUnwrap(groups, "\(path) declares no application groups")
    }

    func testTheAppIsSignedForTheGroupItsCodeUses() throws {
        let granted = try appGroups(inEntitlementsAt: "App/FKPhotos.entitlements")
        XCTAssertTrue(granted.contains(SharedStorage.appGroupID),
                      "SharedStorage asks for \(SharedStorage.appGroupID), but the app is "
                      + "signed for \(granted). An unentitled suite writes into the app's "
                      + "own sandbox and never reaches the extension.")
    }

    func testTheExtensionIsSignedForTheSameGroup() throws {
        let app = try appGroups(inEntitlementsAt: "App/FKPhotos.entitlements")
        let ext = try appGroups(inEntitlementsAt: "F4milShare/ShareExtension.entitlements")
        XCTAssertEqual(Set(app), Set(ext),
                       "The app and the share extension are signed for different app groups; "
                       + "nothing they write can reach the other.")
    }

    func testTheTripPayloadUsesTheSameGroupAsEverythingElse() {
        // One box, not two: the find and the token travel together.
        XCTAssertEqual(TripSharePayload.appGroupID, SharedStorage.appGroupID)
    }

    /// The extension links no library, so its copies of the id are
    /// literals this bundle cannot reference. Read them as text.
    func testNoSourceFileNamesAGroupNobodyIsSignedFor() throws {
        let granted = Set(try appGroups(inEntitlementsAt: "App/FKPhotos.entitlements"))
        let sources = [
            "F4milShare/ShareViewController.swift",
            "F4milShare/TripSharePayload.swift",
            "F4milShare/TripShareCapture.swift",
            "Sources/FKPhotos/Core/Storage/SharedStorage.swift",
            "Sources/FKPhotos/Features/Sync/UploadQueue.swift",
            "Sources/FKPhotos/Features/TripPlanner/TripSharePayload.swift",
            "Sources/FKPhotos/Features/TripPlanner/TripShareInbox.swift",
        ]
        // Any "group.…" string literal in these files has to be granted.
        let pattern = try NSRegularExpression(pattern: #""(group\.[A-Za-z0-9._-]+)""#)

        for path in sources {
            let text = try String(contentsOf: iosRoot.appending(path: path), encoding: .utf8)
            let range = NSRange(text.startIndex..<text.endIndex, in: text)
            for match in pattern.matches(in: text, range: range) {
                guard let found = Range(match.range(at: 1), in: text) else { continue }
                let group = String(text[found])
                XCTAssertTrue(granted.contains(group),
                              "\(path) names the app group \(group), which neither target is "
                              + "signed for. Granted: \(granted.sorted().joined(separator: ", "))")
            }
        }
    }
}
