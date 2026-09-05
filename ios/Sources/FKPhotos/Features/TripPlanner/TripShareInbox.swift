import Foundation

/// The app's side of the share handover (§9.2).
///
/// One payload, read once and cleared. Reading is deliberately
/// destructive: a find you have already been offered should not follow
/// you around, and the alternative — a queue — would need a way to
/// empty it, which is a screen nobody asked for.
///
/// Stale payloads are dropped rather than shown. A link shared three
/// weeks ago and never confirmed is not a pending task; turning up with
/// it at the start of the next trip would be a small ambush.
enum TripShareInbox {
    /// Injectable so the tests are not at the mercy of a real App Group
    /// (which a unit-test bundle does not have anyway).
    static func defaults() -> UserDefaults? {
        UserDefaults(suiteName: TripSharePayload.appGroupID)
    }

    /// Is something waiting? Does not consume it — the planner list
    /// uses this to decide whether to show its banner.
    static func peek(_ store: UserDefaults? = defaults()) -> TripSharePayload? {
        guard let data = store?.data(forKey: TripSharePayload.defaultsKey) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let payload = try? decoder.decode(TripSharePayload.self, from: data) else {
            // Undecodable means a payload from another version of the
            // format. Clearing it is better than showing a banner that
            // opens nothing, over and over.
            store?.removeObject(forKey: TripSharePayload.defaultsKey)
            return nil
        }
        if payload.isStale || payload.isEmpty {
            store?.removeObject(forKey: TripSharePayload.defaultsKey)
            return nil
        }
        return payload
    }

    /// Take it, and leave the inbox empty.
    static func take(_ store: UserDefaults? = defaults()) -> TripSharePayload? {
        let payload = peek(store)
        store?.removeObject(forKey: TripSharePayload.defaultsKey)
        return payload
    }

    static func clear(_ store: UserDefaults? = defaults()) {
        store?.removeObject(forKey: TripSharePayload.defaultsKey)
    }

    /// Only the extension writes in normal use; this exists so a test
    /// can put something in the inbox without encoding by hand.
    static func put(_ payload: TripSharePayload, into store: UserDefaults?) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(payload) else { return }
        store?.set(data, forKey: TripSharePayload.defaultsKey)
    }
}
