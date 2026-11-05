import Foundation
import UIKit

/// Keeps the app out of its own share sheet.
///
/// The app ships a share extension (`F4milShare`) that accepts images, text
/// and URLs, so iOS would offer „F4mil“ as a target when the app itself opens
/// the share sheet — sharing a photo from the app back into the app. A share
/// extension appears in `UIActivityViewController` with its bundle identifier
/// as activity type, so listing that identifier in `excludedActivityTypes`
/// removes it.
///
/// The identifiers are read from the extensions bundled in the running app
/// (`PlugIns/*.appex`) rather than written down here, so a renamed bundle id
/// or another extension stays covered without touching this file.
enum OwnAppShareExclusion {
    /// Activity types of every extension bundled with the running app.
    static var activityTypes: [UIActivity.ActivityType] {
        bundleIdentifiers(inPlugInsAt: Bundle.main.builtInPlugInsURL)
            .map { UIActivity.ActivityType(rawValue: $0) }
    }

    /// Bundle identifiers of the `.appex` bundles in `plugInsURL`.
    ///
    /// Reads each extension's `Info.plist` directly; a folder without one, or
    /// a plist without `CFBundleIdentifier`, is skipped. Sorted for a stable
    /// order.
    static func bundleIdentifiers(inPlugInsAt plugInsURL: URL?) -> [String] {
        guard let plugInsURL,
              let entries = try? FileManager.default.contentsOfDirectory(
                at: plugInsURL,
                includingPropertiesForKeys: nil
              )
        else { return [] }

        return entries
            .filter { $0.pathExtension == "appex" }
            .compactMap { appex -> String? in
                let plist = appex.appendingPathComponent("Info.plist")
                guard let data = try? Data(contentsOf: plist),
                      let info = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
                      let identifier = info["CFBundleIdentifier"] as? String,
                      !identifier.isEmpty
                else { return nil }
                return identifier
            }
            .sorted()
    }
}

extension UIActivityViewController {
    /// The system share sheet for `items`, without the app's own extensions.
    static func excludingOwnApp(items: [Any]) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
        controller.excludedActivityTypes = OwnAppShareExclusion.activityTypes
        return controller
    }
}
