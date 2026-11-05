import Foundation

/// Follows one turn over its WebSocket, the way the web does
/// (`followTurn` and `askStreaming` in frontend/src/api/assistant.ts).
///
/// Each frame is one JSON `StreamEvent`; the server pings every 25 s and
/// closes the socket after `done`, `error` or `cancelled`. A socket that
/// drops — a phone changes networks more often than a browser — is opened
/// again with `resume=true`; the server then replays the whole turn, and the
/// events already seen are skipped so the screen does not show them twice.
/// The turn itself keeps running on the server throughout: nothing is lost
/// while the app is in the background, and should the socket not come back
/// at all the answer is still stored with the conversation.
public struct TurnFollower: Sendable {
    public enum Failure: Error, Equatable, Sendable {
        /// The socket could not be reached again; the answer may still be stored.
        case lost
        /// The server ended the turn with an error (`code` is the APIError code).
        case server(message: String, code: String?)
        /// The user stopped the turn.
        case cancelled
    }

    /// How long to wait before each reopening; after the last one the turn counts as lost.
    public static let reconnectDelays: [Duration] = [
        .seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(15), .seconds(30),
    ]

    /// A socket that has sent nothing for this long — not even a ping — is
    /// dead, whatever the system thinks of it.
    public static let quietLimit: Duration = .seconds(60)

    let api: AssistantAPI
    let session: URLSession

    public init(api: AssistantAPI, session: URLSession = .shared) {
        self.api = api
        self.session = session
    }

    /// Opens the stream, calls `start` once the socket is up (the POST that
    /// starts the turn), then yields the turn's events until it ends. The
    /// stream finishes after `done`; it throws a `Failure` otherwise, or the
    /// error `start` threw.
    public func events(
        turnId: String,
        start: @escaping @Sendable () async throws -> Void
    ) -> AsyncThrowingStream<StreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var cursor = ReplayCursor()
                var attempt = 0
                var started = false
                do {
                    while true {
                        let request = await api.streamRequest(turnId: turnId, resume: started)
                        let socket = session.webSocketTask(with: request)
                        socket.resume()
                        if !started {
                            // The socket is opened first so no event can slip
                            // by between the start and the watching; the
                            // server replays anyway, but a turn whose start
                            // failed must not leave a socket waiting.
                            do {
                                try await start()
                            } catch {
                                socket.cancel(with: .goingAway, reason: nil)
                                throw error
                            }
                            started = true
                        }
                        do {
                            while true {
                                let frame = try await Self.receive(socket, within: Self.quietLimit)
                                guard let event = Self.decode(frame) else { continue }
                                if event.type == "ping" { continue }
                                guard cursor.admit() else { continue }
                                attempt = 0
                                continuation.yield(event)
                                if let failure = Self.failure(ending: event) { throw failure }
                                if event.type == "done" {
                                    socket.cancel(with: .normalClosure, reason: nil)
                                    continuation.finish()
                                    return
                                }
                            }
                        } catch let failure as Failure {
                            socket.cancel(with: .normalClosure, reason: nil)
                            throw failure
                        } catch {
                            // The socket went away mid-turn. Open it again,
                            // and skip what was already shown.
                            socket.cancel(with: .goingAway, reason: nil)
                            if Task.isCancelled { throw CancellationError() }
                            guard let delay = Self.delay(forAttempt: attempt) else { throw Failure.lost }
                            attempt += 1
                            try await Task.sleep(for: delay)
                            cursor.prepareReplay()
                        }
                    }
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// The wait before reopening attempt `attempt` (0-based); nil once they are used up.
    static func delay(forAttempt attempt: Int) -> Duration? {
        attempt < reconnectDelays.count ? reconnectDelays[attempt] : nil
    }

    static func decode(_ message: URLSessionWebSocketTask.Message) -> StreamEvent? {
        let data: Data
        switch message {
        case .string(let text): data = Data(text.utf8)
        case .data(let d): data = d
        @unknown default: return nil
        }
        // A frame that is not one of ours is not an error, as on the web.
        return try? JSONDecoder().decode(StreamEvent.self, from: data)
    }

    /// `error` and `cancelled` end the turn as failures; `done` ends it well.
    static func failure(ending event: StreamEvent) -> Failure? {
        switch event.type {
        case "error":
            // The server forgot the turn (a restart, or it expired): what the web calls `turn_lost`.
            if event.code == "not_found", event.message == "turn unknown" { return .lost }
            return .server(message: event.message ?? "Die Frage konnte nicht beantwortet werden.", code: event.code)
        case "cancelled":
            return .cancelled
        default:
            return nil
        }
    }

    /// One frame, or an error once `limit` passes without one. The receive
    /// cannot be cancelled from the outside, so the timeout closes the
    /// socket under it instead, which makes it throw.
    static func receive(_ socket: URLSessionWebSocketTask, within limit: Duration) async throws -> URLSessionWebSocketTask.Message {
        try await withThrowingTaskGroup(of: URLSessionWebSocketTask.Message.self) { group in
            group.addTask { try await socket.receive() }
            group.addTask {
                try await Task.sleep(for: limit)
                socket.cancel(with: .goingAway, reason: nil)
                throw QuietSocket()
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw QuietSocket() }
            return first
        }
    }

    struct QuietSocket: Error {}
}

/// Which events of a replayed turn are new. A reconnected socket replays the
/// turn from its first event; the ones shown before are let through again
/// by the server but not by this.
struct ReplayCursor: Equatable {
    /// Events shown so far.
    private(set) var seen = 0
    /// Events of the current socket still to skip.
    private(set) var skip = 0

    /// True when the event is new and is to be shown.
    mutating func admit() -> Bool {
        if skip > 0 {
            skip -= 1
            return false
        }
        seen += 1
        return true
    }

    /// Before a reopened socket: everything shown so far comes again first.
    mutating func prepareReplay() {
        skip = seen
    }
}
