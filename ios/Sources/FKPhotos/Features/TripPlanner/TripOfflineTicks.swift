import Foundation

/// A tick made without a network (offline review, F2; Anton 16.11.):
/// "Erledigt", "Doch nicht", "Übersprungen" on a stop, or the answer to
/// "Wart ihr hier?". Kept on the phone and sent in the order it was
/// tapped once the server answers again. Everything else about a plan
/// still changes only with a connection.
struct TripQueuedTick: Codable, Equatable, Sendable {
    enum Kind: String, Codable, Sendable {
        case status
        case visitAnswer
    }

    var id = UUID()
    let planId: Int
    let kind: Kind
    var stopId: Int? = nil
    var status: String? = nil
    var visitId: Int? = nil
    var confirmed: Bool? = nil
    var utcOffsetMinutes: Int? = nil
    var at = Date()

    static func status(planId: Int, stopId: Int, status: TripStopStatus) -> TripQueuedTick {
        TripQueuedTick(planId: planId, kind: .status, stopId: stopId, status: status.rawValue)
    }

    static func visitAnswer(planId: Int, visitId: Int, confirmed: Bool,
                            utcOffsetMinutes: Int) -> TripQueuedTick {
        TripQueuedTick(planId: planId, kind: .visitAnswer, visitId: visitId,
                       confirmed: confirmed, utcOffsetMinutes: utcOffsetMinutes)
    }
}

enum TripTickQueue {
    static let key = "tripPlanner.offline.ticks"
    /// A trip's worth of taps; past that the oldest go first.
    static let capacity = 300

    static func load(from store: UserDefaults = .standard) -> [TripQueuedTick] {
        guard let data = store.data(forKey: key),
              let ticks = try? JSONDecoder().decode([TripQueuedTick].self, from: data)
        else { return [] }
        return ticks
    }

    private static func save(_ ticks: [TripQueuedTick], to store: UserDefaults) {
        if ticks.isEmpty {
            store.removeObject(forKey: key)
        } else if let data = try? JSONEncoder().encode(ticks) {
            store.set(data, forKey: key)
        }
    }

    /// Adds a tick. A newer status for the same stop replaces the older
    /// one — "Erledigt" and then "Doch nicht" in the tunnel is one
    /// "Doch nicht" for the server, not two writes.
    static func append(_ tick: TripQueuedTick, to store: UserDefaults = .standard) {
        var ticks = load(from: store)
        if tick.kind == .status {
            ticks.removeAll { $0.kind == .status && $0.planId == tick.planId && $0.stopId == tick.stopId }
        }
        if tick.kind == .visitAnswer {
            ticks.removeAll { $0.kind == .visitAnswer && $0.planId == tick.planId && $0.visitId == tick.visitId }
        }
        ticks.append(tick)
        if ticks.count > capacity { ticks.removeFirst(ticks.count - capacity) }
        save(ticks, to: store)
    }

    static func remove(_ tick: TripQueuedTick, from store: UserDefaults = .standard) {
        save(load(from: store).filter { $0.id != tick.id }, to: store)
    }

    /// The stops of a trip with a status still waiting to be sent.
    static func queuedStopIds(planId: Int, in store: UserDefaults = .standard) -> Set<Int> {
        Set(load(from: store).filter { $0.planId == planId && $0.kind == .status }.compactMap(\.stopId))
    }

    /// The plan as it looks with every waiting status applied — what the
    /// screens show while the server does not know yet, also after the
    /// app was closed in between.
    static func applied(to plan: TripPlan, in store: UserDefaults = .standard) -> TripPlan {
        applied(load(from: store), to: plan)
    }

    static func applied(_ ticks: [TripQueuedTick], to plan: TripPlan) -> TripPlan {
        var plan = plan
        for tick in ticks where tick.planId == plan.id && tick.kind == .status {
            guard let stopId = tick.stopId, let status = tick.status else { continue }
            for l in plan.legs.indices {
                for d in plan.legs[l].days.indices {
                    for b in plan.legs[l].days[d].blocks.indices {
                        for s in plan.legs[l].days[d].blocks[b].stops.indices
                        where plan.legs[l].days[d].blocks[b].stops[s].rowId == stopId {
                            plan.legs[l].days[d].blocks[b].stops[s].status = status
                        }
                    }
                }
            }
        }
        return plan
    }

    @MainActor private static var isFlushing = false

    /// Sends what waits, oldest first, and answers the trips that
    /// changed. Stops at the first "no network" and keeps the rest; a
    /// tick the server refuses (a stop that is gone) is dropped, since
    /// sending it again would be refused again.
    @MainActor
    @discardableResult
    static func flush(store: UserDefaults = .standard) async -> Set<Int> {
        guard !isFlushing else { return [] }
        isFlushing = true
        defer { isFlushing = false }
        var changed: Set<Int> = []
        for tick in load(from: store) {
            do {
                try await send(tick)
                changed.insert(tick.planId)
                remove(tick, from: store)
            } catch let error where TripOfflineReach.meansUnreachable(error) {
                break
            } catch {
                remove(tick, from: store)
            }
        }
        return changed
    }

    private struct Ignored: Decodable {}

    private static func send(_ tick: TripQueuedTick) async throws {
        switch tick.kind {
        case .status:
            struct Body: Encodable {
                let stopId: Int
                let status: String
            }
            guard let stopId = tick.stopId, let status = tick.status else { return }
            let _: Ignored = try await APIClient.shared.post(
                "/trip-planner/plans/\(tick.planId)/stops/status",
                body: Body(stopId: stopId, status: status))
        case .visitAnswer:
            struct Body: Encodable {
                let visitId: Int
                let confirmed: Bool
                let utcOffsetMinutes: Int
            }
            guard let visitId = tick.visitId, let confirmed = tick.confirmed else { return }
            let _: Ignored = try await APIClient.shared.post(
                "/trip-planner/plans/\(tick.planId)/visits/answer",
                body: Body(visitId: visitId, confirmed: confirmed,
                           utcOffsetMinutes: tick.utcOffsetMinutes ?? TripInstant.utcOffsetMinutes()))
        }
    }
}
