import Foundation

/// Who owns the session the share extension reads.
///
/// The app keeps the durable copy in the Keychain and mirrors it into
/// the App Group; the extension can only read the group, and refreshes
/// there when its fifteen minutes run out. That rotation never reaches
/// the Keychain — the extension cannot write it — so the two copies
/// legitimately disagree, and the group is the newer one.
///
/// Which makes the mirror rule the whole question: **fill the group,
/// never overwrite it.** A session in the group belongs to whoever
/// refreshed last, and the app's own refresh writes both halves anyway
/// (`saveTokens`), so the only thing an unconditional mirror could do is
/// undo a rotation the extension just made — and the server's grace on
/// a rotated refresh token is five minutes, after which only a fresh
/// login helps.
enum SharedSession {
    /// Should the app write its Keychain session into the App Group?
    ///
    /// Yes when the group holds no usable pair: a first run, an app
    /// update from a version that never wrote one, cleared app-group
    /// data. No when it does — that pair is at least as new as this one.
    static func shouldMirror(groupToken: String?, groupRefreshToken: String?) -> Bool {
        let hasToken = groupToken?.isEmpty == false
        let hasRefresh = groupRefreshToken?.isEmpty == false
        // Both halves or nothing: a token without the means to renew it
        // is a session with fifteen minutes to live, and replacing it
        // with a complete pair is an improvement rather than a loss.
        return !(hasToken && hasRefresh)
    }
}
