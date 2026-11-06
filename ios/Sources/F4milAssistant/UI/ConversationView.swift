import SwiftUI
import F4milCore

/// One conversation: the messages, the turn running now, and the question
/// field at the bottom.
struct ConversationView: View {
    let host: AssistantHost
    let api: AssistantAPI
    @State private var store: ConversationStore
    @State private var opener: RowOpener
    @State private var thumbnails: ThumbnailStore
    @State private var draft = ""
    @FocusState private var composing: Bool
    @Environment(\.scenePhase) private var scenePhase

    /// `context`: what a new conversation is about (a selection of photos);
    /// ignored for an existing one.
    init(conversationId: Int?, context: [ContextRef] = [], host: AssistantHost, api: AssistantAPI) {
        self.host = host
        self.api = api
        _store = State(initialValue: ConversationStore(conversationId: conversationId, context: context, api: api))
        _opener = State(initialValue: RowOpener(host: host, api: api))
        _thumbnails = State(initialValue: ThumbnailStore(api: api))
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    if let gate = store.gate, let message = gate.message {
                        GateNotice(gate: gate, message: message)
                    }
                    if let error = store.loadError {
                        Text(error).font(.footnote).foregroundStyle(.secondary)
                    }
                    if !store.context.isEmpty {
                        ContextStrip(items: store.context)
                    }
                    if store.messages.isEmpty, store.live == nil, !store.isLoading {
                        EmptyConversation(host: host, contextTypes: store.contextTypes) { question in
                            Task { await store.ask(question) }
                        }
                    }
                    ForEach(store.messages) { message in
                        MessageView(message: message, opener: opener)
                            .id(message.id)
                    }
                    if let live = store.live {
                        LiveTurnView(turn: live, opener: opener) {
                            Task { await store.cancel() }
                        }
                        .id("live")
                    }
                    if let error = store.turnError {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: store.live?.text.count) { _, _ in
                withAnimation { proxy.scrollTo("live", anchor: .bottom) }
            }
            .onChange(of: store.messages.count) { _, _ in
                if let last = store.messages.last?.id {
                    withAnimation { proxy.scrollTo(last, anchor: .bottom) }
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            Composer(
                text: $draft,
                focused: $composing,
                enabled: store.gate?.acceptsQuestions ?? true,
                answering: store.isAnswering
            ) {
                let question = draft
                draft = ""
                Task { await store.ask(question) }
            }
        }
        .environment(thumbnails)
        .navigationTitle(store.summary?.displayTitle ?? "Neue Unterhaltung")
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.load() }
        // Away: the socket is closed so the server pushes the finished answer;
        // back: the turn is watched again (stage 6 of assistent-ios.md).
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background: store.suspendWatching()
            case .active: Task { await store.resumeWatching() }
            default: break
            }
        }
        .sheet(item: $opener.pdf) { item in
            PDFPreviewSheet(item: item, api: api)
        }
        .sheet(item: $opener.web) { item in
            SafariSheet(url: item.url) { opener.web = nil }
                .ignoresSafeArea()
        }
        .alert("Konnte nicht geöffnet werden", isPresented: Binding(
            get: { opener.error != nil },
            set: { if !$0 { opener.error = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(opener.error ?? "")
        }
    }
}

/// What stands above the first question: the model's state, when there is something to say.
private struct GateNotice: View {
    let gate: ModelGate
    let message: String

    var body: some View {
        Label(message, systemImage: gate.acceptsQuestions ? "info.circle" : "exclamationmark.triangle")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
    }
}

/// The working set a conversation was opened over (#1534): one chip per
/// object, as the web shows them above the chat. Dimmed when the object is
/// no longer visible to the user.
private struct ContextStrip: View {
    let items: [ContextItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Kontext")
                .font(.caption)
                .foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(items, id: \.self) { item in
                        Label(item.label, systemImage: Self.icon(for: item.type))
                            .font(.footnote)
                            .lineLimit(1)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(.quaternary.opacity(0.5), in: Capsule())
                            .opacity(item.visible ? 1 : 0.5)
                    }
                }
            }
        }
        .accessibilityLabel("Arbeitskontext: \(items.count) Objekte")
    }

    static func icon(for type: String) -> String {
        switch type {
        case "photo": return "photo"
        case "document": return "doc.text"
        case "transaction": return "eurosign.circle"
        default: return "circle"
        }
    }
}

/// First questions, one per module the user has, as on the web — or, over a
/// working set, questions about what is in it.
private struct EmptyConversation: View {
    let host: AssistantHost
    var contextTypes: Set<String> = []
    let ask: (String) -> Void

    private var questions: [String] {
        contextTypes.isEmpty
            ? SuggestedQuestions.questions(has: host.hasPermission)
            : SuggestedQuestions.questions(aboutContext: contextTypes)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(contextTypes.isEmpty ? "Was möchtest du wissen?" : "Was möchtest du dazu wissen?")
                .font(.headline)
            Text(contextTypes.isEmpty
                 ? "Der Assistent kennt deine Fotos, Dokumente, Finanzen, Zähler und Reisen und antwortet aus dem, was du auch sonst siehst."
                 : "Der Assistent hat die ausgewählten Objekte vor sich und antwortet aus dem, was du auch sonst siehst.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            ForEach(questions, id: \.self) { question in
                Button {
                    ask(question)
                } label: {
                    Text(question)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.top, 24)
    }
}

/// The question field with its send button; "Abbrechen" while an answer runs.
private struct Composer: View {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    let enabled: Bool
    let answering: Bool
    let send: () -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Frage stellen …", text: $text, axis: .vertical)
                .lineLimit(1...6)
                .focused(focused)
                .disabled(!enabled || answering)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.background, in: RoundedRectangle(cornerRadius: 18))
                .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(.quaternary))
            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 30))
            }
            .disabled(!canSend)
            .accessibilityLabel("Frage senden")
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private var canSend: Bool {
        enabled && !answering && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
