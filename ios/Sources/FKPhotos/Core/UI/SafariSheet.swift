import SafariServices
import SwiftUI

/// `SFSafariViewController` wrapped for SwiftUI, for a web page the app
/// shows in place rather than handing to Safari — a shared album the
/// signed-in user is not a member of, for instance (#768 §5a). Bouncing such
/// a URL to Safari would be pointless: it is a universal link, and Safari
/// would hand it straight back.
struct SafariSheet: UIViewControllerRepresentable {
    let url: URL
    /// Called when the built-in „Fertig" button is tapped; the presenter
    /// clears its item binding here.
    let onDone: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onDone: onDone) }

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let vc = SFSafariViewController(url: url)
        vc.delegate = context.coordinator
        return vc
    }

    func updateUIViewController(_ vc: SFSafariViewController, context: Context) {}

    final class Coordinator: NSObject, SFSafariViewControllerDelegate {
        let onDone: () -> Void
        init(onDone: @escaping () -> Void) { self.onDone = onDone }
        func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
            onDone()
        }
    }
}
