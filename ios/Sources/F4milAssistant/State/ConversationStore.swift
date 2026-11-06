import Foundation
import Observation

/// The conversations of the signed-in user, newest first.
@MainActor
@Observable
public final class ConversationListStore {
    public private(set) var conversations: [ConversationSummary] = []
    public private(set) var isLoading = false
    public private(set) var error: String?

    let api: AssistantAPI

    public init(api: AssistantAPI = AssistantAPI()) {
        self.api = api
    }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            conversations = try await api.conversations()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    public func delete(_ conversation: ConversationSummary) async {
        do {
            try await api.deleteConversation(conversation.id)
            conversations.removeAll { $0.id == conversation.id }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// One conversation: its stored messages and the turn running right now.
///
/// A turn is started and then watched; the answer arrives on the stream and
/// is appended as a message once `done` comes with the stored message's id.
/// The conversation itself is created on the first question, so an empty
/// chat left without one leaves nothing behind on the server — unless it was
/// opened over a working set (a selection of photos), which is created at
/// once so the server can describe it, as the web does.
///
/// Leaving the app closes the socket on purpose (`suspendWatching`): the
/// server sends a push for an answer that reached no watcher (stage 6), and a
/// socket a suspended app still holds would count as one. Coming back
/// reopens the stream with the turn replayed (`resumeWatching`).
@MainActor
@Observable
public final class ConversationStore {
    public private(set) var summary: ConversationSummary?
    public private(set) var messages: [ConversationMessage] = []
    public private(set) var context: [ContextItem] = []
    public private(set) var gate: ModelGate?
    public private(set) var isLoading = false
    public private(set) var loadError: String?
    /// The turn being answered; nil between questions.
    public private(set) var live: LiveTurn?
    /// Why the last turn ended without an answer, shown under the chat until the next question.
    public private(set) var turnError: String?

    let api: AssistantAPI
    let follower: TurnFollower
    private var turnId: String?
    private var streamTask: Task<Void, Never>?
    /// The working set a new conversation is to be created with.
    private var pendingContext: [ContextRef]
    /// The app is in the background: the socket is closed, the turn runs on.
    private(set) var watchingSuspended = false

    /// `conversationId` nil: a new conversation, created with the first
    /// question — or at once, when `context` names what it is about.
    public init(
        conversationId: Int?,
        context: [ContextRef] = [],
        api: AssistantAPI = AssistantAPI(),
        follower: TurnFollower? = nil
    ) {
        self.api = api
        self.follower = follower ?? TurnFollower(api: api)
        self.pendingContext = conversationId == nil ? context : []
        if let conversationId {
            summary = ConversationSummary(id: conversationId, title: nil, created_at: "", updated_at: "")
        }
    }

    public var isAnswering: Bool { live.map { !$0.finished } ?? false }

    /// The kinds in the working set, for the first questions to suggest.
    public var contextTypes: Set<String> {
        Set(context.map(\.type)).union(pendingContext.map(\.type))
    }

    public func load() async {
        if summary == nil, !pendingContext.isEmpty {
            isLoading = true
            do {
                summary = try await api.createConversation(context: pendingContext)
                pendingContext = []
            } catch {
                loadError = error.localizedDescription
            }
            isLoading = false
        }
        if let id = summary?.id {
            isLoading = true
            do {
                let detail = try await api.conversation(id)
                summary = detail.summary
                messages = detail.messages
                context = detail.context
                loadError = nil
            } catch {
                loadError = error.localizedDescription
            }
            isLoading = false
        }
        // What the model's state means for the question field; a failure here
        // only leaves the notice away.
        gate = try? await api.modelGate()
    }

    /// Asks; returns once the turn has ended, well or not.
    public func ask(_ question: String) async {
        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isAnswering else { return }
        turnError = nil
        do {
            if summary == nil {
                summary = try await api.createConversation(context: pendingContext)
                pendingContext = []
            }
        } catch {
            turnError = error.localizedDescription
            return
        }
        guard let conversationId = summary?.id else { return }
        let turnId = TurnID.make()
        self.turnId = turnId
        watchingSuspended = false
        // Shown at once, under a provisional id; the server's copy comes with the reload.
        messages.append(ConversationMessage(id: -messages.count - 1, role: "user", content: text, blocks: [], created_at: Self.now()))
        live = LiveTurn()
        let api = self.api
        let stream = follower.events(turnId: turnId) {
            try await api.startTurn(conversation: conversationId, message: text, turnId: turnId)
        }
        await follow(stream)
    }

    /// Applies the stream's events to the running turn until it ends.
    private func follow(_ stream: AsyncThrowingStream<StreamEvent, Error>) async {
        let task = Task { @MainActor [weak self] in
            do {
                for try await event in stream {
                    guard let self, !Task.isCancelled else { return }
                    self.live?.apply(event)
                }
                self?.finishTurn()
            } catch {
                guard let self, !self.watchingSuspended else { return }
                await self.failTurn(error)
            }
        }
        streamTask = task
        await task.value
        if streamTask == task { streamTask = nil }
    }

    /// "Abbrechen" under a running answer: the server stops the turn at its
    /// next step and the stream ends with `cancelled`.
    public func cancel() async {
        guard let turnId, isAnswering else { return }
        _ = try? await api.cancelTurn(turnId)
    }

    /// The app leaves the foreground while an answer runs: close the socket,
    /// keep what was shown. The server then counts nobody watching and sends
    /// a push when the answer is done.
    public func suspendWatching() {
        guard isAnswering, let task = streamTask else { return }
        watchingSuspended = true
        task.cancel()
        streamTask = nil
    }

    /// Back in the foreground: watch the turn again. The server replays it
    /// from its first event, so the turn is rebuilt from an empty one; a turn
    /// the server has forgotten (finished more than ten minutes ago) ends as
    /// lost, and the reload shows the stored answer.
    public func resumeWatching() async {
        guard watchingSuspended, let turnId else { return }
        watchingSuspended = false
        live = LiveTurn()
        await follow(follower.events(turnId: turnId, resuming: true))
    }

    private func finishTurn() {
        guard let turn = live else { return }
        let answer = turn.text.trimmingCharacters(in: .whitespacesAndNewlines)
        messages.append(ConversationMessage(
            id: turn.messageId ?? -messages.count - 1,
            role: "assistant",
            content: answer,
            blocks: turn.blocks,
            created_at: Self.now()
        ))
        live = nil
        // The title is written in the background after the first answer; a
        // reload picks it up, together with the server's ids.
        Task { await self.reload() }
    }

    private func failTurn(_ error: Error) async {
        live = nil
        // The server's view of the conversation replaces the provisional
        // question: a cancelled or refused turn stored nothing, a lost one
        // may have finished meanwhile.
        await reload()
        let unanswered = messages.last?.isUser == true
        switch error {
        case let failure as TurnFollower.Failure:
            switch failure {
            case .cancelled:
                turnError = nil
            case .lost:
                turnError = unanswered
                    ? "Die Verbindung zur laufenden Antwort ist abgerissen. Die Antwort erscheint hier, sobald sie fertig ist."
                    : nil
            case .server(let message, _):
                turnError = message
            }
        case is CancellationError:
            turnError = nil
        default:
            turnError = error.localizedDescription
        }
    }

    private func reload() async {
        guard let id = summary?.id else { return }
        if let detail = try? await api.conversation(id) {
            summary = detail.summary
            messages = detail.messages
            context = detail.context
        }
    }

    private static func now() -> String {
        ISO8601DateFormatter().string(from: Date())
    }
}
