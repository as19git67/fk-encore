import CoreLocation
import Foundation

/// A suggestion the auto-end monitor has raised for the currently active trip,
/// surfaced both as a local notification and as a banner in `TripView` (in
/// case the notification was missed, dismissed unseen, or never authorized).
struct PendingAutoEndSuggestion: Codable, Equatable, Sendable {
    /// The trip this suggestion is about. Matched against `activeTrip.iosAlbumId`
    /// before acting on it — a suggestion for a trip that has since ended or been
    /// replaced is stale and ignored.
    var tripIosAlbumId: String
    var raisedAt: Date
}

/// Tuning + persisted state for "you're back home, end the trip?"
/// (`docs/ios-trip-mode.md` §9, the ending half). Pure decision helpers plus
/// UserDefaults persistence — no CoreLocation monitoring here, that lives in
/// `TripAutoEndMonitor`.
enum TripAutoEndPreferences {
    /// How close to home counts as "arrived", in metres. Doubles as the radius
    /// of a trip's home exclusion zone (`TripMembership.homeExclusionRadiusMeters`),
    /// so "you are back home" and "this photo was taken at home" draw the same
    /// circle. Tight on purpose: the trip's time window is the actual rule, and
    /// a wide circle around home would start eating legitimate photos from the
    /// first hours of a trip that begins in the user's own city.
    static let homeArrivalRadiusMeters: CLLocationDistance = 2_000

    /// How long the device must stay continuously within the radius before the
    /// suggestion fires. Significant-change updates are sparse (roughly every
    /// few hundred metres of movement or few minutes), so this is evaluated
    /// across updates via `homeArrivalCandidateSince`, not a single check.
    /// Long enough that stopping for a meal near home on the way back doesn't
    /// trigger it; short enough to be useful the same evening.
    static let homeArrivalGrace: TimeInterval = 2 * 60 * 60

    /// After a suggestion is dismissed (or acted on), how long before the
    /// monitor may raise another one — otherwise leaving the radius briefly
    /// (a supermarket run) and coming back would re-ask right away.
    static let suggestionCooldown: TimeInterval = 6 * 60 * 60

    /// How long a cached home location is trusted before the monitor fetches a
    /// fresh one. Home rarely changes; a week keeps the endpoint call rare
    /// without risking a stale location for someone who moved.
    static let homeLocationTTL: TimeInterval = 7 * 24 * 60 * 60

    private static let homeLocationKey = "trip.autoend.homeLocation"
    private static let homeLocationFetchedAtKey = "trip.autoend.homeLocationFetchedAt"
    private static let candidateSinceKey = "trip.autoend.candidateSince"
    private static let lastSuggestionAtKey = "trip.autoend.lastSuggestionAt"
    private static let pendingSuggestionKey = "trip.autoend.pendingSuggestion"

    // MARK: - Home location cache

    static var homeLocation: CLLocationCoordinate2D? {
        get {
            let d = UserDefaults.standard
            guard d.object(forKey: homeLocationKey) != nil else { return nil }
            let lat = d.double(forKey: homeLocationKey + ".lat")
            let lon = d.double(forKey: homeLocationKey + ".lon")
            return CLLocationCoordinate2D(latitude: lat, longitude: lon)
        }
        set {
            let d = UserDefaults.standard
            guard let newValue else {
                d.removeObject(forKey: homeLocationKey)
                d.removeObject(forKey: homeLocationKey + ".lat")
                d.removeObject(forKey: homeLocationKey + ".lon")
                return
            }
            d.set(true, forKey: homeLocationKey)
            d.set(newValue.latitude, forKey: homeLocationKey + ".lat")
            d.set(newValue.longitude, forKey: homeLocationKey + ".lon")
            d.set(Date(), forKey: homeLocationFetchedAtKey)
        }
    }

    /// Whether the cached home location is still fresh enough to use without
    /// re-fetching.
    static var isHomeLocationFresh: Bool {
        guard homeLocation != nil,
              let fetchedAt = UserDefaults.standard.object(forKey: homeLocationFetchedAtKey) as? Date
        else { return false }
        return Date().timeIntervalSince(fetchedAt) < homeLocationTTL
    }

    // MARK: - Arrival tracking

    /// When the device was first seen within the home radius on this
    /// continuous stay. `nil` once it leaves the radius again.
    static var homeArrivalCandidateSince: Date? {
        get { UserDefaults.standard.object(forKey: candidateSinceKey) as? Date }
        set {
            if let newValue {
                UserDefaults.standard.set(newValue, forKey: candidateSinceKey)
            } else {
                UserDefaults.standard.removeObject(forKey: candidateSinceKey)
            }
        }
    }

    static var lastSuggestionAt: Date? {
        get { UserDefaults.standard.object(forKey: lastSuggestionAtKey) as? Date }
        set {
            if let newValue {
                UserDefaults.standard.set(newValue, forKey: lastSuggestionAtKey)
            } else {
                UserDefaults.standard.removeObject(forKey: lastSuggestionAtKey)
            }
        }
    }

    static var pendingSuggestion: PendingAutoEndSuggestion? {
        get {
            guard let data = UserDefaults.standard.data(forKey: pendingSuggestionKey) else { return nil }
            return try? JSONDecoder().decode(PendingAutoEndSuggestion.self, from: data)
        }
        set {
            guard let newValue, let data = try? JSONEncoder().encode(newValue) else {
                UserDefaults.standard.removeObject(forKey: pendingSuggestionKey)
                return
            }
            UserDefaults.standard.set(data, forKey: pendingSuggestionKey)
        }
    }

    /// Clears all per-trip arrival state. Called whenever the active trip
    /// changes (started, ended, or a suggestion was resolved) so a new trip —
    /// or the moment right after ending one — never inherits stale tracking.
    static func resetArrivalTracking() {
        homeArrivalCandidateSince = nil
    }
}

/// Pure decision core for the auto-end heuristic, kept separate from
/// `TripAutoEndPreferences`'s storage and from `TripAutoEndMonitor`'s
/// CLLocationManager plumbing so the arrival logic is unit-testable
/// (`TripAutoEndHeuristicTests`).
enum TripAutoEndHeuristic {
    /// Whether `location` counts as "at home".
    static func isAtHome(_ location: CLLocationCoordinate2D, home: CLLocationCoordinate2D) -> Bool {
        let a = CLLocation(latitude: location.latitude, longitude: location.longitude)
        let b = CLLocation(latitude: home.latitude, longitude: home.longitude)
        return a.distance(from: b) <= TripAutoEndPreferences.homeArrivalRadiusMeters
    }

    /// Given the current arrival-candidate timestamp (nil if the device was
    /// last seen away or this is the first sample), the last time a suggestion
    /// fired, and whether the device is at home right now, decides what to do.
    struct Decision: Equatable {
        /// The `homeArrivalCandidateSince` value to persist afterwards.
        var candidateSince: Date?
        /// Whether to raise a new suggestion now.
        var shouldSuggest: Bool
    }

    static func evaluate(
        candidateSince: Date?,
        lastSuggestionAt: Date?,
        isAtHome: Bool,
        now: Date
    ) -> Decision {
        guard isAtHome else {
            // Left the radius: the continuous stay is over, start fresh next time.
            return Decision(candidateSince: nil, shouldSuggest: false)
        }

        let since = candidateSince ?? now
        guard now.timeIntervalSince(since) >= TripAutoEndPreferences.homeArrivalGrace else {
            return Decision(candidateSince: since, shouldSuggest: false)
        }

        if let lastSuggestionAt,
           now.timeIntervalSince(lastSuggestionAt) < TripAutoEndPreferences.suggestionCooldown {
            // Long enough at home, but we already asked recently — keep the
            // candidate timestamp so a later evaluation (once the cooldown
            // passes) doesn't have to wait through the grace period again.
            return Decision(candidateSince: since, shouldSuggest: false)
        }

        return Decision(candidateSince: since, shouldSuggest: true)
    }
}
