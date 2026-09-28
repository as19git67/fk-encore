import Foundation

/// Where a trip stands today, and which day of it that is (§8.1, §8.5).
///
/// A trip is not "started" by pressing anything. It has dates, and one
/// of its days is today — that is the whole mechanism, and it is the
/// only one that survives the app being closed for a week, the phone
/// being off, or the traveller flying a day early. A button would have
/// to be pressed, and the day it was pressed on is exactly the day
/// nobody has their phone out.
///
/// Every date here is a **day**, never an instant. `YYYY-MM-DD` in, day
/// arithmetic in the traveller's own calendar, `YYYY-MM-DD` out. A leg
/// that starts on the 17th starts on the 17th in Lisbon and in Tokyo,
/// and `toISOString()`-shaped arithmetic would move it by a day for
/// half the world.
enum TripCalendar {
    /// The formatter for a date-only string. Fixed locale and a fixed
    /// format: a German phone would otherwise write "17.09.2026", which
    /// is not what the server means by a date.
    private static func formatter(_ timeZone: TimeZone) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }

    /// The day `date` falls on, as `YYYY-MM-DD`.
    static func isoDay(_ date: Date, timeZone: TimeZone = .current) -> String {
        formatter(timeZone).string(from: date)
    }

    /// Midday on the given day — midday rather than midnight so that a
    /// daylight-saving change cannot tip it into the day before.
    static func date(fromIsoDay day: String, timeZone: TimeZone = .current) -> Date? {
        guard let midnight = formatter(timeZone).date(from: day) else { return nil }
        return midnight.addingTimeInterval(12 * 3_600)
    }

    /// Whole days from one day to the next, positive when `to` is later.
    static func days(from: String, to: String, timeZone: TimeZone = .current) -> Int? {
        guard let start = date(fromIsoDay: from, timeZone: timeZone),
              let end = date(fromIsoDay: to, timeZone: timeZone) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.dateComponents([.day], from: start, to: end).day
    }

    /// `startDate` plus `offset` days.
    static func day(_ day: String, plus offset: Int, timeZone: TimeZone = .current) -> String? {
        guard let date = date(fromIsoDay: day, timeZone: timeZone) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        guard let shifted = calendar.date(byAdding: .day, value: offset, to: date) else { return nil }
        return isoDay(shifted, timeZone: timeZone)
    }
}

/// Which leg and day of a trip a given date falls on.
struct TripDayPosition: Equatable, Sendable {
    let legIndex: Int
    let dayIndex: Int
}

/// How a trip relates to today. What the list row says, and what
/// decides whether opening the trip lands on day one or on today.
enum TripSchedule: Equatable, Sendable {
    /// No dates yet — a plan for "some time".
    case undated
    /// Starts in `days` days (1 = tomorrow).
    case upcoming(days: Int)
    /// Running: `dayNumber` of `dayCount`, both counted from one.
    case running(dayNumber: Int, dayCount: Int)
    /// Over, `days` days ago.
    case past(days: Int)

    var label: String {
        switch self {
        case .undated:
            return "Noch ohne Datum"
        case .upcoming(let days):
            if days == 1 { return "Morgen geht’s los" }
            return "In \(days) Tagen"
        case .running(let dayNumber, let dayCount):
            return "Läuft — Tag \(dayNumber) von \(dayCount)"
        case .past(let days):
            if days == 1 { return "Gestern zu Ende" }
            return "Vor \(days) Tagen zu Ende"
        }
    }

    /// Is this the trip the traveller is on right now? Drives the map
    /// icon and whether the day screen opens on today.
    var isRunning: Bool {
        if case .running = self { return true }
        return false
    }
}

extension TripPlan {
    /// Which day of this trip `today` is, or nil when the trip has no
    /// dates or today is not in it.
    ///
    /// Date *and* time (§22.7): a day with a journey holds three legs —
    /// the morning of the one being left, the journey, the evening of
    /// the one arrived at — and the clock says which of them is being
    /// lived. The same rule as the server's `running-day.ts`.
    func position(on today: Date, timeZone: TimeZone = .current) -> TripDayPosition? {
        let day = TripCalendar.isoDay(today, timeZone: timeZone)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.hour, .minute], from: today)
        let minutes = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)

        var candidates: [(leg: TripLeg, day: TripDay)] = []
        for leg in legs.sorted(by: { $0.position < $1.position }) {
            guard let start = leg.startDate,
                  let offset = TripCalendar.days(from: start, to: day, timeZone: timeZone),
                  offset >= 0, offset < leg.days.count
            else { continue }
            // `dayIndex` is what the endpoints address, and it is not
            // necessarily the position in the array.
            guard let matched = leg.days.first(where: { $0.dayIndex == offset })
                ?? leg.days.sorted(by: { $0.dayIndex < $1.dayIndex }).dropFirst(offset).first
            else { continue }
            candidates.append((leg: leg, day: matched))
        }
        guard let chosen = TripRunningDayRule.pick(candidates, at: minutes) else { return nil }
        return TripDayPosition(legIndex: chosen.leg.position, dayIndex: chosen.day.dayIndex)
    }

    /// How many calendar days the trip spans. Not the sum of its legs'
    /// days: a journey shares its first day with the leg it leaves and
    /// its last with the leg it reaches (§22.7).
    var calendarDayCount: Int {
        let dated = legs.filter { $0.startDate != nil && !$0.days.isEmpty }
        let undated = legs.filter { $0.startDate == nil }.reduce(0) { $0 + $1.days.count }
        guard let first = dated.compactMap(\.startDate).min() else { return undated }
        let lasts = dated.compactMap { leg in
            leg.startDate.flatMap { TripCalendar.day($0, plus: leg.days.count - 1, timeZone: .current) }
        }
        guard let last = lasts.max(),
              let span = TripCalendar.days(from: first, to: last, timeZone: .current)
        else { return undated }
        return span + 1 + undated
    }

    /// The trip's own start date: the earliest leg that has one.
    var startDate: String? {
        legs.sorted(by: { $0.position < $1.position }).compactMap(\.startDate).first
    }

    /// How the whole trip relates to today.
    func schedule(on today: Date, timeZone: TimeZone = .current) -> TripSchedule {
        TripScheduling.schedule(
            startDate: startDate, dayCount: calendarDayCount, today: today, timeZone: timeZone)
    }
}

/// Which of several legs sharing a date is being lived at a minute
/// (§22.7) — pure, so the rule can be tested without a plan.
///
/// Each leg's day has a window: it opens at midnight, or later on the
/// first day of a leg (the arrival, or a journey's departure), and
/// closes at midnight, or earlier on a day with a departure. The day
/// whose window holds the minute wins; between windows, the one that
/// opened last; before any has opened, the first.
enum TripRunningDayRule {
    static func window(of leg: TripLeg, day: TripDay) -> ClosedRange<Int> {
        let first = day.dayIndex == (leg.days.map(\.dayIndex).min() ?? 0)
        let opens = !first ? 0 : leg.isTransit ? (leg.departMinutes ?? 0) : (leg.arriveMinutes ?? 0)
        let departures = day.fixpoints.filter { $0.kind == "departure" }.map(\.startMinutes)
        let closes = departures.min() ?? 24 * 60
        return opens...max(opens, closes)
    }

    static func pick(_ candidates: [(leg: TripLeg, day: TripDay)], at minutes: Int)
        -> (leg: TripLeg, day: TripDay)? {
        guard candidates.count > 1 else { return candidates.first }
        if let inside = candidates.first(where: {
            let w = window(of: $0.leg, day: $0.day)
            return minutes >= w.lowerBound && minutes < w.upperBound
        }) {
            return inside
        }
        let opened = candidates.filter { window(of: $0.leg, day: $0.day).lowerBound <= minutes }
        return opened.last ?? candidates.first
    }
}

extension TripPlanSummary {
    func schedule(on today: Date, timeZone: TimeZone = .current) -> TripSchedule {
        TripScheduling.schedule(
            startDate: startDate, dayCount: dayCount, today: today, timeZone: timeZone)
    }
}

/// The arithmetic behind both `schedule` methods. One copy: a list row
/// saying "läuft" while the trip itself disagrees is the kind of
/// difference nobody notices until it matters.
enum TripScheduling {
    static func schedule(
        startDate: String?,
        dayCount: Int,
        today: Date,
        timeZone: TimeZone = .current,
    ) -> TripSchedule {
        guard let startDate,
              let offset = TripCalendar.days(
                  from: startDate,
                  to: TripCalendar.isoDay(today, timeZone: timeZone),
                  timeZone: timeZone)
        else { return .undated }

        if offset < 0 { return .upcoming(days: -offset) }
        let length = max(1, dayCount)
        if offset < length { return .running(dayNumber: offset + 1, dayCount: length) }
        return .past(days: offset - length + 1)
    }
}

extension TripLeg {
    /// How this leg relates to today — running, upcoming, past, or undated.
    func schedule(on today: Date, timeZone: TimeZone = .current) -> TripSchedule {
        TripScheduling.schedule(startDate: startDate, dayCount: days.count, today: today, timeZone: timeZone)
    }

    /// The day of this leg, as a short label ("Do, 17.9."), or nil when
    /// the trip has no dates.
    func date(ofDayIndex dayIndex: Int, timeZone: TimeZone = .current) -> String? {
        guard let startDate,
              let day = TripCalendar.day(startDate, plus: dayIndex, timeZone: timeZone),
              let date = TripCalendar.date(fromIsoDay: day, timeZone: timeZone)
        else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale.current
        formatter.timeZone = timeZone
        formatter.setLocalizedDateFormatFromTemplate("EEEdMMM")
        return formatter.string(from: date)
    }

    /// Is this day of this leg today?
    func isToday(dayIndex: Int, now: Date = Date(), timeZone: TimeZone = .current) -> Bool {
        guard let startDate,
              let offset = TripCalendar.days(
                  from: startDate, to: TripCalendar.isoDay(now, timeZone: timeZone),
                  timeZone: timeZone)
        else { return false }
        return offset == dayIndex
    }
}
