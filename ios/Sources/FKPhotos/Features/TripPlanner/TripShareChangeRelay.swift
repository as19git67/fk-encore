import Foundation
import Observation

/// The app's side of `TripShareChange`: read the extension's note and
/// make whatever is open read the trip again.
///
/// Read when the app comes forward (`ContentView`) and when the
/// extension rings while the app is already on screen beside it. One
/// reader on purpose — reading clears the note, and two screens racing
/// for it would leave one of them stale.
@Observable @MainActor
final class TripShareChangeRelay {
    static let shared = TripShareChangeRelay()

    /// Bumped whenever the collection got an idea from outside; the
    /// ideas screen reloads on a change of it.
    private(set) var ideasVersion = 0

    @ObservationIgnored private var listening = false
    @ObservationIgnored private let store: UserDefaults?

    init(store: UserDefaults? = UserDefaults(suiteName: TripSharePayload.appGroupID)) {
        self.store = store
    }

    /// Listen for the extension's ring. Safe to call more than once.
    func start() {
        guard !listening else { return }
        listening = true
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(), nil,
            { _, _, _, _, _ in
                Task { @MainActor in TripShareChangeRelay.shared.apply() }
            },
            TripShareChange.darwinName as CFString, nil, .deliverImmediately)
    }

    /// Read the note, if there is one, and pass it on.
    @discardableResult
    func apply() -> TripShareChange? {
        guard let change = TripShareChange.take(from: store) else { return nil }
        if change.ideas { ideasVersion += 1 }
        TripPlannerViewModel.changedOutside(change)
        return change
    }
}
