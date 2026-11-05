import SwiftUI
import F4milCore

/// Where the host app leads the assistant: the user's conversations, with a
/// way into a new one. Lives inside the app's own `NavigationStack`; the
/// chat is pushed from here.
public struct AssistantRootView: View {
    let host: AssistantHost
    let api: AssistantAPI
    @State private var store: ConversationListStore
    /// A new conversation is a destination of its own, so "Neue Unterhaltung"
    /// pushes an empty chat and the list stays behind it.
    @State private var newChat: UUID?

    public init(host: AssistantHost, api: AssistantAPI = AssistantAPI()) {
        self.host = host
        self.api = api
        _store = State(initialValue: ConversationListStore(api: api))
    }

    public var body: some View {
        List {
            if let error = store.error {
                Text(error)
                    .foregroundStyle(.secondary)
                    .font(.footnote)
            }
            if store.conversations.isEmpty, !store.isLoading, store.error == nil {
                ContentUnavailableView(
                    "Noch keine Unterhaltung",
                    systemImage: "bubble.left.and.text.bubble.right",
                    description: Text("Stell eine Frage über Fotos, Dokumente, Finanzen, Zähler oder Reisen. Der Assistent liest nur, was du auch siehst.")
                )
                .listRowSeparator(.hidden)
            }
            ForEach(store.conversations) { conversation in
                NavigationLink(value: AssistantDestination.conversation(id: conversation.id)) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(conversation.displayTitle)
                            .lineLimit(2)
                        Text(Self.when(conversation.updated_at))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .swipeActions {
                    Button("Löschen", systemImage: "trash", role: .destructive) {
                        Task { await store.delete(conversation) }
                    }
                }
            }
        }
        .listStyle(.plain)
        .overlay {
            if store.isLoading, store.conversations.isEmpty {
                ProgressView()
            }
        }
        .navigationTitle("Assistent")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Neue Unterhaltung", systemImage: "square.and.pencil") {
                    newChat = UUID()
                }
            }
        }
        .navigationDestination(for: AssistantDestination.self) { destination in
            switch destination {
            case .conversation(let id):
                ConversationView(conversationId: id, host: host, api: api)
            }
        }
        .navigationDestination(item: $newChat) { _ in
            ConversationView(conversationId: nil, host: host, api: api)
        }
        .task { await store.load() }
        .refreshable { await store.load() }
    }

    /// `2026-11-05T12:34:56.000Z` → the date, as the list has room for.
    static func when(_ iso: String) -> String {
        guard let date = ISO8601DateFormatter.lenient.date(from: iso) else { return "" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}

enum AssistantDestination: Hashable {
    case conversation(id: Int)
}

/// One conversation as a screen of its own, for the two ways in that do not
/// pass the list: a push for a finished answer opens its conversation, and
/// „Assistent fragen" over a selection opens a new one with that working
/// set (documentation/plans/assistent-ios.md, stage 6). Lives inside the
/// app's `NavigationStack`.
public struct AssistantChatView: View {
    let conversationId: Int?
    let context: [ContextRef]
    let host: AssistantHost
    let api: AssistantAPI

    /// An existing conversation.
    public init(conversationId: Int, host: AssistantHost, api: AssistantAPI = AssistantAPI()) {
        self.conversationId = conversationId
        self.context = []
        self.host = host
        self.api = api
    }

    /// A new conversation about `context` — at most `ContextRef.maxItems`
    /// objects; the rest is dropped, as the server would drop it.
    public init(context: [ContextRef], host: AssistantHost, api: AssistantAPI = AssistantAPI()) {
        self.conversationId = nil
        self.context = Array(context.prefix(ContextRef.maxItems))
        self.host = host
        self.api = api
    }

    public var body: some View {
        ConversationView(conversationId: conversationId, context: context, host: host, api: api)
    }
}

extension ISO8601DateFormatter {
    /// The server writes fractional seconds; a stored row without them must parse too.
    static let lenient: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
