import F4milAssistant
import SwiftUI

/// The assistant inside the Photos app (documentation/plans/assistent-ios.md,
/// stages 3 and 6). The package draws the chat; this file is what the Photos
/// app adds to it — the ways in, and which rows it opens itself.
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

/// „Assistent fragen" over photos (stage 6): the photos become the working
/// set of a new conversation, as a selection on the web does with
/// `?context=photo:12,…`. What the selection toolbars and the album menu push.
struct AssistantAsk: Hashable {
    let photoIds: [Int]

    /// As many photos as the server keeps in one working set.
    static let maxPhotos = ContextRef.maxItems

    var context: [ContextRef] { photoIds.map { ContextRef.photo($0) } }
}

/// The toolbar item that asks about a selection. Absent without the module,
/// with nothing selected, or with more photos than fit a working set — the
/// user then narrows the selection; a disabled button would not say why.
struct AssistantAskButton: View {
    let photoIds: [Int]
    @Environment(AuthManager.self) private var auth

    var body: some View {
        if auth.hasPermission("module.assistant"), !photoIds.isEmpty, photoIds.count <= AssistantAsk.maxPhotos {
            NavigationLink(value: AssistantAsk(photoIds: photoIds)) {
                Label("Assistent fragen", systemImage: "bubble.left.and.text.bubble.right")
            }
        }
    }
}

/// The screen a push or the list leads to: an existing conversation by id,
/// else the list of conversations.
struct AssistantScreen: View {
    var conversationId: Int? = nil
    @Environment(AuthManager.self) private var auth

    var body: some View {
        if let conversationId {
            AssistantChatView(conversationId: conversationId, host: PhotosAssistantHost.make(auth: auth))
        } else {
            AssistantRootView(host: PhotosAssistantHost.make(auth: auth))
        }
    }
}

/// A new conversation over the photos of an `AssistantAsk`.
struct AssistantAskScreen: View {
    let ask: AssistantAsk
    @Environment(AuthManager.self) private var auth

    var body: some View {
        AssistantChatView(context: ask.context, host: PhotosAssistantHost.make(auth: auth))
    }
}

extension View {
    /// Registers the assistant's destinations at a tab's stack root, so
    /// „Assistent fragen" works from every screen pushed on that stack and
    /// is declared once per stack.
    func assistantDestinations() -> some View {
        navigationDestination(for: AssistantAsk.self) { ask in
            AssistantAskScreen(ask: ask)
        }
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
                // A row pointing back at the assistant stays where it is.
                if case .assistant = link { return false }
                router.open(link)
                return true
            }
        )
    }
}
