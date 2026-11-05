import XCTest
@testable import FKPhotosLib

/// The share sheet leaves out the app's own extensions; these lock how their
/// bundle identifiers are found in a `PlugIns` folder.
final class OwnAppShareExclusionTests: XCTestCase {
    private var plugIns: URL!

    override func setUpWithError() throws {
        plugIns = FileManager.default.temporaryDirectory
            .appendingPathComponent("plugins-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: plugIns, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: plugIns)
    }

    private func addBundle(_ name: String, info: [String: Any]?) throws {
        let dir = plugIns.appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if let info {
            let data = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
            try data.write(to: dir.appendingPathComponent("Info.plist"))
        }
    }

    func testReadsIdentifiersOfEveryExtension() throws {
        try addBundle("Share.appex", info: ["CFBundleIdentifier": "test.app.share"])
        try addBundle("Widgets.appex", info: ["CFBundleIdentifier": "test.app.widgets"])

        XCTAssertEqual(
            OwnAppShareExclusion.bundleIdentifiers(inPlugInsAt: plugIns),
            ["test.app.share", "test.app.widgets"]
        )
    }

    func testSkipsFoldersThatAreNotExtensionsOrHaveNoIdentifier() throws {
        try addBundle("Share.appex", info: ["CFBundleIdentifier": "test.app.share"])
        try addBundle("Other.bundle", info: ["CFBundleIdentifier": "test.app.other"])
        try addBundle("Empty.appex", info: ["CFBundleName": "Empty"])
        try addBundle("NoPlist.appex", info: nil)

        XCTAssertEqual(OwnAppShareExclusion.bundleIdentifiers(inPlugInsAt: plugIns), ["test.app.share"])
    }

    func testMissingFolderGivesNothing() {
        XCTAssertEqual(OwnAppShareExclusion.bundleIdentifiers(inPlugInsAt: nil), [])
        XCTAssertEqual(
            OwnAppShareExclusion.bundleIdentifiers(inPlugInsAt: plugIns.appendingPathComponent("missing")),
            []
        )
    }
}
