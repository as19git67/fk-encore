import Foundation

/// Shared UserDefaults suite accessible by both the main app and the Share Extension
/// via the App Group `group.dev.fk-encore.VivantyPhotos`.
///
/// The main app mirrors the auth token and server URL here so the extension can
/// make API calls without needing access to the main app's Keychain items.
enum SharedStorage {
    static let appGroupID        = "group.dev.fk-encore.VivantyPhotos"
    static let tokenKey          = "shared.auth_token"
    static let serverURLKey      = "shared.serverURL"
    static let recentAlbumIdsKey = "shared.recentAlbumIds"

    /// Returns the App Group UserDefaults suite, falling back to `.standard`
    /// if the entitlement is not configured (e.g. in unit tests).
    static var defaults: UserDefaults {
        UserDefaults(suiteName: appGroupID) ?? .standard
    }

    static var recentAlbumIds: [Int] {
        defaults.array(forKey: recentAlbumIdsKey) as? [Int] ?? []
    }

    static func saveRecentAlbumIds(_ ids: [Int]) {
        defaults.set(ids, forKey: recentAlbumIdsKey)
    }
}
