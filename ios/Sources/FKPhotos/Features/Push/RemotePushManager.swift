import Foundation
import Observation
import UIKit
import UserNotifications

/// Remote push over APNs (#765): the app's end of what `push/apns.service.ts`
/// stores and `push/apns-client.ts` sends.
///
/// The flow is the platform's: ask iOS for a device token, hand it to the
/// server, and repeat on every launch, because the token can change (after
/// a restore, or an OS update) and the server only ever knows the last one
/// it was given. Opt-in, as on the web: nothing is registered until the
/// switch in Einstellungen → Benachrichtigungen is on, and turning it off
/// (or signing out) tells the server to forget the device.
///
/// What a tapped notification opens is the `url` the server puts into the
/// payload — the web-relative path every feed notification already carries
/// — resolved against the configured server and routed through
/// `AppDeepLink`, so a push lands on the same screen a link would.
@MainActor
@Observable
final class RemotePushManager {
    static let shared = RemotePushManager()

    enum State: Equatable {
        /// Not asked yet, or the server has no APNs credentials.
        case unavailable
        case off
        /// iOS refused notification permission; the switch cannot help.
        case denied
        case registering
        case on
        case failed(String)
    }

    private(set) var state: State = RemotePushPreferences.isEnabled ? .registering : .off
    /// Whether the server can send at all — read once per session.
    private(set) var serverEnabled: Bool?

    private static let tokenKey = "push.apns.deviceToken"

    private init() {}

    // MARK: - Switch

    /// The user turned push on: ask for permission, then for a token. The
    /// token arrives in `didRegister(deviceToken:)` via the app delegate.
    func enable() async {
        RemotePushPreferences.isEnabled = true
        state = .registering
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        guard granted else {
            state = .denied
            return
        }
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// The user turned push off: forget the device server-side and stop
    /// receiving. iOS keeps handing out the token, which is fine — nothing
    /// is sent to it any more.
    func disable() async {
        RemotePushPreferences.isEnabled = false
        state = .off
        if let token = UserDefaults.standard.string(forKey: Self.tokenKey) {
            struct Body: Encodable { let token: String }
            _ = try? await APIClient.shared.post("/push/apns/unregister", body: Body(token: token)) as RemovedResponse
        }
        UserDefaults.standard.removeObject(forKey: Self.tokenKey)
    }

    // MARK: - Launch

    /// Re-register on every launch while the switch is on. Quiet: no
    /// permission prompt here (it was answered when the switch was turned
    /// on), and no error surfaced beyond the settings screen.
    func registerIfEnabled() async {
        await refreshServerStatus()
        guard RemotePushPreferences.isEnabled else {
            state = serverEnabled == false ? .unavailable : .off
            return
        }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
            state = .denied
            return
        }
        state = .registering
        UIApplication.shared.registerForRemoteNotifications()
    }

    func refreshServerStatus() async {
        struct Status: Decodable { let enabled: Bool }
        if let status: Status = try? await APIClient.shared.get("/push/apns/status") {
            serverEnabled = status.enabled
        }
    }

    // MARK: - App delegate callbacks

    /// iOS handed over the token. Sent to the server as hex; the same
    /// token again is an upsert there.
    func didRegister(deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(token, forKey: Self.tokenKey)
        guard RemotePushPreferences.isEnabled else { return }
        Task { await upload(token: token) }
    }

    func didFailToRegister(_ error: Error) {
        state = .failed(error.localizedDescription)
    }

    private func upload(token: String) async {
        struct Body: Encodable {
            let token: String
            let environment: String
            let deviceName: String
        }
        struct Registered: Decodable { let id: Int }
        do {
            let _: Registered = try await APIClient.shared.post(
                "/push/apns/register",
                body: Body(token: token, environment: Self.environment, deviceName: UIDevice.current.name)
            )
            state = .on
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// Which Apple gateway the token belongs to. A build from Xcode carries
    /// the development `aps-environment` and registers with the sandbox;
    /// TestFlight and App Store builds are production. The entitlement is
    /// not readable at run time, so the build configuration stands in for
    /// it — which is exactly how Xcode assigns the entitlement.
    static var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    // MARK: - Sign-out

    /// The account is leaving this phone: the server must not push its
    /// notifications here any more.
    func handleSignOut() async {
        if let token = UserDefaults.standard.string(forKey: Self.tokenKey) {
            struct Body: Encodable { let token: String }
            _ = try? await APIClient.shared.post("/push/apns/unregister", body: Body(token: token)) as RemovedResponse
        }
        UserDefaults.standard.removeObject(forKey: Self.tokenKey)
        RemotePushPreferences.isEnabled = false
        state = .off
    }

    private struct RemovedResponse: Decodable { let removed: Int }
}

/// The switch. Off until turned on: a permission prompt at first launch,
/// for a feature the user has not met, is how notification permission
/// gets denied for good.
enum RemotePushPreferences {
    private static let enabledKey = "push.apns.enabled"

    static var isEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: enabledKey) }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }
}
