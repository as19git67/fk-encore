import Foundation

/// How a recap picks its Apple Music, without touching MusicKit — so the
/// rules can be tested on their own. `RecapAppleMusic` does the playing.
///
/// The order, first match wins:
///  1. the playlist the user chose for this recap in the player;
///  2. songs the user added to their own library around the recap's period
///     ("the music of that time"), when the period is short enough to mean a
///     time and there are enough of them;
///  3. an Apple Music playlist for the recap's mood (the same mood that picks
///     the self-hosted track on the server, `moodForKind`);
///  4. nothing — the player falls back to the self-hosted music.
///
/// Apple Music only ever plays live in the app. An exported or shared video
/// keeps the license-free music.
enum RecapAppleMusicPlan {
    /// Days the library window reaches beyond the recap's period on each side:
    /// what you listened to just before a trip belongs to it too.
    static let windowPaddingDays = 30
    /// A period longer than this is no "time" any more (a person across ten
    /// years); its library songs would be a random sample of the library.
    static let maxPeriodDays = 183
    /// Fewer library songs than this sound like a loop, not a soundtrack.
    static let minimumLibrarySongs = 8
    /// Upper bound of songs queued from the library.
    static let maximumLibrarySongs = 100

    /// The span of library additions that belongs to a recap, or nil when the
    /// recap has no usable period.
    static func libraryWindow(periodStart: String?, periodEnd: String?) -> DateInterval? {
        guard let start = parseDate(periodStart) else { return nil }
        let end = parseDate(periodEnd) ?? start
        guard end >= start else { return nil }
        let day: TimeInterval = 86_400
        guard end.timeIntervalSince(start) <= Double(maxPeriodDays) * day else { return nil }
        let padding = Double(windowPaddingDays) * day
        return DateInterval(
            start: start.addingTimeInterval(-padding),
            end: end.addingTimeInterval(padding)
        )
    }

    /// The items added inside `window`, or an empty list when there are too
    /// few of them to carry a recap. Order is kept; the caller shuffles.
    static func librarySongs<T>(
        _ items: [T],
        addedAt: (T) -> Date?,
        in window: DateInterval
    ) -> [T] {
        let hits = items.filter { item in
            guard let date = addedAt(item) else { return false }
            return window.contains(date)
        }
        guard hits.count >= minimumLibrarySongs else { return [] }
        return Array(hits.prefix(maximumLibrarySongs))
    }

    /// The caption the player shows for a time-based pick, e.g. "Juli 2023"
    /// or "Juni – August 2023".
    static func periodLabel(periodStart: String?, periodEnd: String?, calendar: Calendar = .current) -> String? {
        guard let start = parseDate(periodStart) else { return nil }
        let end = parseDate(periodEnd) ?? start
        let month = DateFormatter()
        month.locale = Locale(identifier: "de_DE")
        month.calendar = calendar
        month.timeZone = calendar.timeZone
        let startYear = calendar.component(.year, from: start)
        let endYear = calendar.component(.year, from: end)
        let sameMonth = calendar.isDate(start, equalTo: end, toGranularity: .month)
        if sameMonth {
            month.dateFormat = "LLLL yyyy"
            return month.string(from: start)
        }
        if startYear == endYear {
            month.dateFormat = "LLLL"
            let from = month.string(from: start)
            month.dateFormat = "LLLL yyyy"
            return "\(from) – \(month.string(from: end))"
        }
        month.dateFormat = "LLLL yyyy"
        return "\(month.string(from: start)) – \(month.string(from: end))"
    }

    /// The period fields arrive as ISO 8601, with or without fractional
    /// seconds.
    static func parseDate(_ raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: raw) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: raw) { return date }
        let dateOnly = ISO8601DateFormatter()
        dateOnly.formatOptions = [.withFullDate]
        return dateOnly.date(from: raw)
    }
}

/// The mood of a recap (`RecapMood` on the server).
enum RecapMusicMood: String, Sendable, CaseIterable {
    case upbeat
    case warm
    case nostalgic
    case calm

    init?(raw: String?) {
        guard let raw, let mood = RecapMusicMood(rawValue: raw) else { return nil }
        self = mood
    }

    /// Catalog search terms, tried in order until one finds a playlist
    /// curated by Apple Music.
    var catalogSearchTerms: [String] {
        switch self {
        case .upbeat:    return ["Feel Good", "Gute Laune"]
        case .warm:      return ["Love Songs", "Acoustic Love"]
        case .nostalgic: return ["Throwback", "Back in Time"]
        case .calm:      return ["Pure Chill", "Chill"]
        }
    }

    /// German word for the caption ("Apple Music · ruhig").
    var label: String {
        switch self {
        case .upbeat:    return "gute Laune"
        case .warm:      return "warm"
        case .nostalgic: return "nostalgisch"
        case .calm:      return "ruhig"
        }
    }
}

/// What the user decided about Apple Music in recaps, on this device.
enum AppleMusicPreferences {
    static let enabledKey = "recaps.appleMusic.enabled"
    static let playlistKeyPrefix = "recaps.appleMusic.playlist."

    /// Off until the user switches it on in the settings: the first use asks
    /// iOS for access to the music library, and that question belongs in the
    /// settings, not in the middle of a recap.
    static var enabled: Bool {
        get { UserDefaults.standard.bool(forKey: enabledKey) }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }

    /// The library playlist chosen for one recap, or nil for the automatic
    /// pick.
    static func playlistId(forRecap recapId: Int, defaults: UserDefaults = .standard) -> String? {
        let value = defaults.string(forKey: playlistKeyPrefix + String(recapId))
        return (value?.isEmpty ?? true) ? nil : value
    }

    static func setPlaylistId(_ id: String?, forRecap recapId: Int, defaults: UserDefaults = .standard) {
        let key = playlistKeyPrefix + String(recapId)
        if let id, !id.isEmpty {
            defaults.set(id, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
}
