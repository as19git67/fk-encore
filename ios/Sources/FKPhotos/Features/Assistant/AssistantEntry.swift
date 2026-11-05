import F4milAssistant
import SwiftUI

/// The assistant inside the Photos app (documentation/plans/assistent-ios.md,
/// stage 3). The package draws the chat; this file is what the Photos app
/// adds to it — the way in, and which rows it opens itself.
///
/// Shown only to someone with the module: the server refuses everyone else,
/// and a button that leads to a refusal is worse than none.
struct AssistantEntryButton: View {
    @Environment(AuthManager.self) private var auth

    var body: some View {
        if auth.hasPermission("module.assistant") {
            NavigationLink(value: AssistantRef()) {
                Image(systemName: "bubble.left.and.text.bubble.right")
            }
            .accessibilityLabel("Assistent")
        }
    }
}

/// The destination the button pushes; the host view resolves the hooks.
struct AssistantRef: Hashable {}

struct AssistantScreen: View {
    @Environment(AuthManager.self) private var auth

    var body: some View {
        AssistantRootView(host: PhotosAssistantHost.make(auth: auth))
    }
}

enum PhotosAssistantHost {
    /// What the Photos app lends the assistant: its permissions, and the
    /// screens it has. A row whose web path the deep-link parser knows —
    /// a photo, an album, a person, the recaps — goes through the same
    /// router a notification tap uses, so it opens the same way from
    /// anywhere (#768 §5a). Everything else the assistant opens itself,
    /// as a PDF preview or in the web view.
    @MainActor
    static func make(auth: AuthManager) -> AssistantHost {
        AssistantHost(
            hasPermission: { auth.hasPermission($0) },
            openRoute: { _, webURL in
                let router = AppDeepLinkRouter.shared
                guard let link = AppDeepLink.parse(webURL, serverURL: router.serverURL) else { return false }
                router.open(link)
                return true
            }
        )
    }
}
