import CoreLocation
import Foundation

/// A raised "looks like you're travelling — start Trip Mode?" suggestion
/// (`docs/ios-trip-mode.md` §9.2), surfaced as a local notification and as a
/// banner in `TripView`'s no-trip state.
struct PendingStartSuggestion: Codable, Equatable, Sendable {
    /// Prefill for `TripStartSheet` — a place name where reverse geocoding
    /// worked, otherwise the plain date-based default.
    var suggestedName: String
    /// Grid cell the suggestion is about, so "für diesen Ort nicht mehr fragen"
    /// knows what to silence (§9.3).
    var regionCell: String
    /// When the earliest away-from-home photo of the cluster was taken. Shown
    /// as context; the trip itself still starts *now* when the user confirms —
    /// backdating a trip would pull in photos the user never agreed to sync.
    var travellingSince: Date
    var raisedAt: Date
}

/// Tuning + persisted state for the trip **start** suggestion.
///
/// Kept apart from `TripAutoEndPreferences` on purpose: a start suggestion the
/// user declined for a region must not silence a later end suggestion, or vice
/// versa (`docs/ios-trip-mode.md` §9.2).
enum TripAutoStartPreferences {
    /// How far from home a photo has to be taken to count as "travelling".
    /// Two orders of magnitude above the 2 km home radius of the end heuristic,
    /// and comfortably beyond a normal day out — a day trip to a nearby lake
    /// is not what Trip Mode is for, and asking about one would be noise.
    static let awayDistanceMeters: CLLocationDistance = 100_000

    /// How long the away-from-home photos must span before asking. Stops a
    /// single airport layover or a motorway service stop from triggering: those
    /// produce a burst of photos within minutes, not spread over hours.
    static let minimumSpan: TimeInterval = 6 * 60 * 60

    /// How far back the scan looks for away-from-home photos. Wide enough to
    /// still catch a trip whose first day the app slept through, narrow enough
    /// that last month's holiday can't resurface as a suggestion.
    static let lookback: TimeInterval = 48 * 60 * 60

    /// The newest away-from-home photo must be at least this fresh. Guards the
    /// "drove home this morning, photos are from yesterday" case — the user is
    /// no longer travelling and asking would be wrong.
    static let recencyWindow: TimeInterval = 12 * 60 * 60

    /// How long to stay quiet after a declined suggestion. Much longer than the
    /// end suggestion's six hours: starting a trip is the bigger commitment, so
    /// a "nicht jetzt" deserves a full day of silence rather than being
    /// re-asked the same evening.
    static let suggestionCooldown: TimeInterval = 24 * 60 * 60

    private static let lastSuggestionAtKey = "trip.autostart.lastSuggestionAt"
    private static let pendingSuggestionKey = "trip.autostart.pendingSuggestion"
    private static let presentStartSheetKey = "trip.autostart.presentStartSheet"

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

    static var pendingSuggestion: PendingStartSuggestion? {
        get {
            guard let data = UserDefaults.standard.data(forKey: pendingSuggestionKey) else { return nil }
            return try? JSONDecoder().decode(PendingStartSuggestion.self, from: data)
        }
        set {
            guard let newValue, let data = try? JSONEncoder().encode(newValue) else {
                UserDefaults.standard.removeObject(forKey: pendingSuggestionKey)
                return
            }
            UserDefaults.standard.set(data, forKey: pendingSuggestionKey)
        }
    }

    /// Set by the notification's "Trip starten" action and consumed by
    /// `TripView`, which then presents the prefilled `TripStartSheet`.
    ///
    /// Starting needs the user to confirm (or edit) the trip name — that name
    /// becomes an iOS album *and* a server album — so unlike ending, the
    /// notification action cannot complete the operation on its own. It hands
    /// off to the sheet instead, and this flag is the handoff: the action may
    /// run while the app is not even launched, long before any view exists to
    /// receive it.
    static var shouldPresentStartSheet: Bool {
        get { UserDefaults.standard.bool(forKey: presentStartSheetKey) }
        set { UserDefaults.standard.set(newValue, forKey: presentStartSheetKey) }
    }
}

/// One geotagged photo, reduced to what the start heuristic needs.
struct TripPhotoSample: Equatable, Sendable {
    var date: Date
    var latitude: Double
    var longitude: Double
}

/// Pure decision core for the trip **start** suggestion, kept free of PhotoKit
/// and UserDefaults so it is unit-testable (`TripAutoStartHeuristicTests`).
///
/// The signal is deliberately photo GPS rather than live location: at this
/// point no trip is running, so there is nothing to justify continuous
/// CoreLocation monitoring and its "Always" permission. The photo library is
/// already being enumerated on every sync pass, and a photo carries both the
/// coordinate and the time — everything the heuristic needs, for free
/// (`docs/ios-trip-mode.md` §9.2).
enum TripAutoStartHeuristic {
    struct Outcome: Equatable {
        /// Earliest away-from-home photo of the cluster.
        var travellingSince: Date
        /// Most recent away-from-home position — the best guess at where the
        /// user is *now*, and what the name suggestion is geocoded from.
        var latitude: Double
        var longitude: Double
        /// Grid cell of that position, for §9.3 suppression.
        var regionCell: String
    }

    /// Returns a suggestion when the samples show a stay far from home that has
    /// lasted long enough, or `nil` otherwise.
    ///
    /// `nil` is the quiet, correct answer for every degenerate case — no
    /// geotagged photos, a single burst, an old cluster — and no caller ever
    /// treats it as an error.
    static func evaluate(
        samples: [TripPhotoSample],
        home: CLLocationCoordinate2D,
        now: Date
    ) -> Outcome? {
        let homeLocation = CLLocation(latitude: home.latitude, longitude: home.longitude)
        let away = samples
            .filter { sample in
                CLLocation(latitude: sample.latitude, longitude: sample.longitude)
                    .distance(from: homeLocation) > awayDistance
            }
            .sorted { $0.date < $1.date }

        guard let earliest = away.first, let latest = away.last else { return nil }

        // A cluster of shots from one moment is a stop, not a stay. Distinct
        // timestamps rather than a plain count: a ten-shot burst is one moment.
        let distinctInstants = Set(away.map(\.date))
        guard distinctInstants.count >= 2 else { return nil }

        guard latest.date.timeIntervalSince(earliest.date) >= TripAutoStartPreferences.minimumSpan
        else { return nil }

        // The user has to still be away — a cluster that ends a day ago is a
        // trip that already finished.
        guard now.timeIntervalSince(latest.date) <= TripAutoStartPreferences.recencyWindow
        else { return nil }

        return Outcome(
            travellingSince: earliest.date,
            latitude: latest.latitude,
            longitude: latest.longitude,
            regionCell: TripRegionGrid.cellKey(
                latitude: latest.latitude, longitude: latest.longitude
            )
        )
    }

    private static var awayDistance: CLLocationDistance {
        TripAutoStartPreferences.awayDistanceMeters
    }

    /// Whether the cooldown still blocks a new suggestion.
    static func isWithinCooldown(lastSuggestionAt: Date?, now: Date) -> Bool {
        guard let lastSuggestionAt else { return false }
        return now.timeIntervalSince(lastSuggestionAt) < TripAutoStartPreferences.suggestionCooldown
    }
}
