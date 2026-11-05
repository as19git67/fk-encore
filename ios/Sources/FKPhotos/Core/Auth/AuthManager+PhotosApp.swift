import Foundation
import F4milCore

public extension AuthManager {
    /// The session manager with what the Photos app does around a sign-out.
    /// `F4milCore` knows the session; it does not know push, widgets or
    /// Spotlight, so the app hands those in here. `Main.swift` builds the one
    /// instance from this.
    static func forPhotosApp() -> AuthManager {
        let manager = AuthManager()
        // The server must stop pushing to this phone before the session that
        // could tell it so is gone (#765).
        manager.willLogout = { await RemotePushManager.shared.handleSignOut() }
        manager.didClearSession = {
            // The widgets never check a session: without this the home screen
            // keeps showing the last account's photo to whoever signs in next.
            WidgetSnapshotStore.clearAll()
            Task { @MainActor in
                // The Spotlight index is per device, the library per user: the
                // next account on this phone must not find this one's photos.
                await SpotlightIndexer.shared.wipeAll()
            }
        }
        return manager
    }
}
