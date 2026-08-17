import CoreLocation
import Foundation

/// Global on/off switch for both trip suggestions (start and end),
/// `docs/ios-trip-mode.md` §9.3. The coarse brake: everything else in §9.3
/// narrows *where* the app asks, this turns asking off entirely.
///
/// Defaults to on — the suggestion is the feature; a user who never wants it
/// finds the switch in the trip settings after the first prompt.
enum TripSuggestionSettings {
    private static let enabledKey = "trip.suggestions.enabled"

    static var enabled: Bool {
        get {
            // `bool(forKey:)` returns false for an unset key, which would
            // silently ship the feature disabled — read the object first so an
            // untouched install gets the intended default.
            guard UserDefaults.standard.object(forKey: enabledKey) != nil else { return true }
            return UserDefaults.standard.bool(forKey: enabledKey)
        }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }
}

/// Maps a coordinate onto a coarse grid cell.
///
/// Same cell size as the server's `HOME_CELL_DEG` (`photo/recaps.service.ts`),
/// so "this region" means the same thing on both sides: ~5.5 km of latitude,
/// coarse enough that a town and its surroundings are one cell, fine enough to
/// tell a home town from a holiday region.
enum TripRegionGrid {
    static let cellDegrees = 0.05

    /// A stable key for the cell containing this coordinate. Longitude cells
    /// get narrower towards the poles, which is fine — this is a bucketing key
    /// for "roughly the same place", not a distance measure.
    static func cellKey(latitude: Double, longitude: Double) -> String {
        let lat = (latitude / cellDegrees).rounded()
        let lon = (longitude / cellDegrees).rounded()
        return "\(Int(lat)):\(Int(lon))"
    }

    static func cellKey(for coordinate: CLLocationCoordinate2D) -> String {
        cellKey(latitude: coordinate.latitude, longitude: coordinate.longitude)
    }
}

/// Per-region "stop asking here" state (`docs/ios-trip-mode.md` §9.3).
///
/// Without this the daily commute would ask "Trip Mode einschalten?" every day.
/// Two ways a region goes quiet, deliberately kept in one set because the
/// effect is identical — the app does not ask here any more:
///
/// 1. **Explicitly**, via the suggestion's "Für diesen Ort nicht mehr fragen"
///    action.
/// 2. **Automatically**, once the region has been visited on
///    `autoSuppressAfterDistinctDays` distinct days. A place you keep coming
///    back to is a second home (work, parents, gym), not a trip — the same
///    "distinct days" idea the server's home detection uses, just applied per
///    region. This is what makes the commute go quiet on its own.
///
/// Only the start suggestion consults this. The end suggestion's region is by
/// definition home, where "don't ask here" would disable the feature outright
/// rather than narrow it — that is what `TripSuggestionSettings.enabled` is
/// for.
enum TripRegionSuppression {
    /// Distinct visit days after which a region stops producing suggestions.
    /// Low enough that a workplace goes quiet within a working week, high
    /// enough that a week-long holiday (which is a trip, and is asked about on
    /// day one anyway) never reaches it.
    static let autoSuppressAfterDistinctDays = 5

    /// Cap on tracked regions, so a lot of travel can't grow this without
    /// bound. When exceeded, the regions with the fewest visit days are dropped
    /// first — they are the ones furthest from mattering.
    static let maxTrackedRegions = 500

    private static let suppressedKey = "trip.suggestions.suppressedRegions"
    private static let visitDaysKey = "trip.suggestions.regionVisitDays"

    // MARK: - Suppression set

    static var suppressedRegions: Set<String> {
        get { Set(UserDefaults.standard.stringArray(forKey: suppressedKey) ?? []) }
        set { UserDefaults.standard.set(Array(newValue), forKey: suppressedKey) }
    }

    static func isSuppressed(cell: String) -> Bool {
        suppressedRegions.contains(cell)
    }

    /// Silences a region for good. Its visit history is dropped at the same
    /// time — it has served its purpose and would only take up space.
    static func suppress(cell: String) {
        var regions = suppressedRegions
        regions.insert(cell)
        suppressedRegions = regions
        var days = visitDays
        days.removeValue(forKey: cell)
        visitDays = days
    }

    // MARK: - Visit tracking (auto-suppression)

    /// Distinct visit days per region, as `yyyy-MM-dd` strings. A region that
    /// reached the threshold is not in here — it moved into `suppressedRegions`.
    private static var visitDays: [String: [String]] {
        get {
            guard let data = UserDefaults.standard.data(forKey: visitDaysKey),
                  let decoded = try? JSONDecoder().decode([String: [String]].self, from: data)
            else { return [:] }
            return decoded
        }
        set {
            guard let data = try? JSONEncoder().encode(newValue) else { return }
            UserDefaults.standard.set(data, forKey: visitDaysKey)
        }
    }

    /// Records that the user was in this region on `date`, and returns whether
    /// that pushed it over the auto-suppression threshold.
    ///
    /// Repeated calls on the same day are free — the day set makes this
    /// idempotent, which matters because the caller runs on every sync pass.
    @discardableResult
    static func recordVisit(cell: String, on date: Date) -> Bool {
        guard !isSuppressed(cell: cell) else { return true }

        let day = dayKey(for: date)
        var all = visitDays
        var days = all[cell] ?? []
        guard !days.contains(day) else { return false }
        days.append(day)

        if days.count >= autoSuppressAfterDistinctDays {
            suppress(cell: cell)
            return true
        }

        all[cell] = days
        visitDays = prunedIfNeeded(all)
        return false
    }

    static func distinctVisitDays(cell: String) -> Int {
        visitDays[cell]?.count ?? 0
    }

    /// Drops the least-visited regions once the map outgrows its cap.
    private static func prunedIfNeeded(_ map: [String: [String]]) -> [String: [String]] {
        guard map.count > maxTrackedRegions else { return map }
        let keep = map.sorted { $0.value.count > $1.value.count }.prefix(maxTrackedRegions)
        return Dictionary(uniqueKeysWithValues: keep.map { ($0.key, $0.value) })
    }

    /// Local calendar day. Deliberately local rather than UTC: "distinct days"
    /// is about the user's days, and a UTC day boundary would split an evening
    /// visit across two days for anyone east of Greenwich.
    static func dayKey(for date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    /// Test seam — clears everything this type persists.
    static func resetAll() {
        UserDefaults.standard.removeObject(forKey: suppressedKey)
        UserDefaults.standard.removeObject(forKey: visitDaysKey)
    }
}
