import Foundation

/// Shared UserDefaults suite accessible by both the main app and the Share Extension
/// via the App Group `group.de.f4mil.photos`.
///
/// The main app mirrors the auth token and server URL here so the extension can
/// make API calls without needing access to the main app's Keychain items.
///
/// **The id has to be the one both targets are signed for.** For an app
/// group a process is not entitled to, `UserDefaults(suiteName:)` does
/// not fail — it hands back a defaults object backed by a plist inside
/// that process's own sandbox. The app writes its token, the extension
/// reads and finds nothing, and the extension's honest conclusion is
/// "not set up: please log in". Both targets' entitlements grant
/// `group.de.f4mil.photos`; the code used to name a group nobody was
/// signed for, so the two processes were talking into separate boxes
/// with the same label. `SharedStorageGroupTests` reads the
/// entitlements files and fails if they ever drift apart again.
///
/// Nothing needs migrating out of the old suite: the Keychain holds the
/// session, and `AuthManager.restoreSession()` mirrors it here on every
/// launch. Correcting the id is enough for the extension to find a
/// token again the next time the app starts.
enum SharedStorage {
    static let appGroupID        = "group.de.f4mil.photos"
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
