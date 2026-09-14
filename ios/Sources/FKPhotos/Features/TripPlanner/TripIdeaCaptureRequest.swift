import Foundation

/// "Das hier merken" asked for from outside the screen that does it.
///
/// The App Shortcut (and Siri) run an intent, and the intent has no
/// view to present a sheet from. So it leaves a request here, the tab
/// bar switches to the Trip tab, and the tab opens the capture sheet
/// and takes the request — the same hand-off the start-suggestion
/// notification uses (`TripAutoStartMonitor.consumeStartSheetRequest`).
///
/// A flag rather than a callback because the app may not be running
/// when the intent fires: `openAppWhenRun` launches it, and the view
/// that should react does not exist yet at that moment.
@Observable @MainActor
final class TripIdeaCaptureRequest {
    static let shared = TripIdeaCaptureRequest()

    /// True while a request waits to be taken.
    private(set) var isRequested = false

    private init() {}

    func request() {
        isRequested = true
    }

    /// Take the request, so it is acted on once.
    func consume() -> Bool {
        guard isRequested else { return false }
        isRequested = false
        return true
    }
}
