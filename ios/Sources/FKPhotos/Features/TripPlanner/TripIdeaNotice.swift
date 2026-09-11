import CoreLocation
import Foundation

/// When the collection may speak up, and what it says (§20.2, §6.4).
///
/// The half §20 is actually about: *„Eine Ideensammlung, die nur eine
/// Liste ist, wird gelesen, bis sie zu lang ist, und danach nie
/// wieder."* A screen answers a question somebody asked; this answers
/// one nobody asked, which is the whole value and the whole risk.
///
/// So every decision in here is a brake:
///
///   - **Off unless switched on.** A collection that starts talking
///     because an app was updated has not been given permission,
///     whatever the permission dialog said.
///   - **Not twice in one walk.** The server keeps an entry quiet for a
///     week after offering it; this adds the other half — the *device*
///     stays quiet between asks, so a phone that wakes six times
///     crossing a town does not spend six entries' silence.
///   - **Only after moving.** Sitting still is not new information, and
///     asking again from the same bench would eventually offer whatever
///     came off quiet, at home, on a Tuesday.
///
/// Pure and free of any actor: these are numbers and sentences, and the
/// monitor next door does the CoreLocation work that cannot be tested.
enum TripIdeaNotice {
    /// How long between two asks, at the earliest.
    ///
    /// Significant-change updates arrive every few hundred metres or
    /// few minutes; without this a drive across a city would be a dozen
    /// questions to the server and — worse — a dozen entries spending
    /// their quiet week unseen in the background.
    static let minimumInterval: TimeInterval = 30 * 60

    /// How far the device must have moved since the last ask.
    ///
    /// Smaller than the radius asked for, because the point is a
    /// *different* surrounding, not a different coordinate.
    static let minimumDistance: CLLocationDistance = 2_000

    /// How far a notice reaches. Tighter than the screen's five
    /// kilometres: unasked, "in der Nähe" has to mean near enough to
    /// act on, or it is an interruption about somewhere else.
    static let radiusM = 2_000

    /// May the collection ask the server now?
    ///
    /// `last` is where and when it last did — nil for "never", which is
    /// always allowed.
    static func mayAsk(
        at position: CLLocation,
        last: (position: CLLocation, at: Date)?,
        now: Date = Date(),
    ) -> Bool {
        guard let last else { return true }
        if now.timeIntervalSince(last.at) < minimumInterval { return false }
        return position.distance(from: last.position) >= minimumDistance
    }

    /// The sentence for the notification, or nil when there is nothing
    /// worth waking somebody for.
    ///
    /// One idea is named, however many came back — "der Biergarten, den
    /// Anna gemerkt hat, ist 900 m von hier" is §20's own form, and a
    /// notification that lists four is a screen pretending to be a
    /// sentence. The rest are counted in the second line.
    static func sentence(for ideas: [TripNearIdea]) -> (title: String, body: String)? {
        guard let nearest = ideas.min(by: { $0.distanceM < $1.distanceM }) else { return nil }

        let name = nearest.displayName
        let who = nearest.addedBy.map { ", den \($0) gemerkt hat" } ?? ""
        let title = "Hier in der Nähe"
        var body = "\(name)\(who) — \(nearest.distanceText) von hier."

        let others = ideas.count - 1
        if others == 1 {
            body += " Eine weitere Idee liegt auch hier."
        } else if others > 1 {
            body += " \(others) weitere Ideen liegen auch hier."
        }
        return (title, body)
    }
}

/// The switch, and what the device remembers between asks.
///
/// In `UserDefaults` rather than on the server: whether *this* phone
/// speaks up is a property of the phone, and a second device signed in
/// to the same collection has its own answer to it.
enum TripIdeaNoticePreferences {
    private static let enabledKey = "ideas.notice.enabled"
    private static let lastAskKey = "ideas.notice.lastAsk"
    private static let lastLatKey = "ideas.notice.lastLat"
    private static let lastLonKey = "ideas.notice.lastLon"

    /// Off until somebody turns it on (§20.5: abschaltbar — and the
    /// honest reading of that is "not on by default").
    static func isEnabled(_ store: UserDefaults = .standard) -> Bool {
        store.bool(forKey: enabledKey)
    }

    static func setEnabled(_ enabled: Bool, _ store: UserDefaults = .standard) {
        store.set(enabled, forKey: enabledKey)
        // Turning it off forgets where it last asked: switching it on
        // again weeks later should not inherit a brake from a different
        // city.
        if !enabled { forgetLastAsk(store) }
    }

    static func lastAsk(_ store: UserDefaults = .standard) -> (position: CLLocation, at: Date)? {
        guard let at = store.object(forKey: lastAskKey) as? Date else { return nil }
        let lat = store.double(forKey: lastLatKey)
        let lon = store.double(forKey: lastLonKey)
        guard lat != 0 || lon != 0 else { return nil }
        return (CLLocation(latitude: lat, longitude: lon), at)
    }

    static func rememberAsk(
        at position: CLLocation,
        now: Date = Date(),
        _ store: UserDefaults = .standard,
    ) {
        store.set(now, forKey: lastAskKey)
        store.set(position.coordinate.latitude, forKey: lastLatKey)
        store.set(position.coordinate.longitude, forKey: lastLonKey)
    }

    static func forgetLastAsk(_ store: UserDefaults = .standard) {
        store.removeObject(forKey: lastAskKey)
        store.removeObject(forKey: lastLatKey)
        store.removeObject(forKey: lastLonKey)
    }
}
