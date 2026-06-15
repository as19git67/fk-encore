import Foundation

/// Shared UserDefaults suite accessible by both the main app and the Share Extension
/// via the App Group `group.dev.fk-encore.VivantyPhotos`.
///
/// The main app mirrors the auth token and server URL here so the extension can
/// make API calls without needing access to the main app's Keychain items.
enum SharedStorage {
    static let appGroupID        = "group.dev.fk-encore.VivantyPhotos"
    static let tokenKey          = "shared.auth_token"
    static let refreshTokenKey   = "shared.refresh_token"
    /// Access-token expiry as epoch seconds (Double). Lets the APIClient and the
    /// Share Extension refresh proactively — the token itself is opaque, so its
    /// expiry can't be derived from it.
    static let tokenExpiryKey    = "shared.auth_token_expiry"
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
