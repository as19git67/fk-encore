import Foundation

// On the road (reise-planen-und-unterwegs.md, stage 5): the stay's
// planning view on the day being lived — what was visited at the top in
// the order it really happened, a "jetzt" line, then what is still to
// come — and what a day left behind.

/// The weather of the hour a visit began, kept on the visit.
struct TripVisitWeather: Codable, Sendable, Equatable {
    let temperatureC: Double
    let precipitationMm: Double
    /// Percent of the sky.
    let cloudCover: Double

    var symbolName: String {
        if precipitationMm >= 1 { return "cloud.rain" }
        if precipitationMm > 0 { return "cloud.drizzle" }
        if cloudCover >= 70 { return "cloud" }
        if cloudCover >= 30 { return "cloud.sun" }
        return "sun.max"
    }

    /// "18°"
    var degrees: String { "\(Int(temperatureC.rounded()))°" }
}

/// One of a spot's photos, for its card.
struct TripDiaryPhoto: Codable, Sendable, Equatable, Identifiable {
    let id: Int
    let filename: String
}

/// What one spot of a day left behind.
struct TripDiarySpot: Codable, Sendable, Equatable {
    let osmRef: String
    let arrivedAt: String?
    let weather: TripVisitWeather?
    let photoCount: Int
    let photos: [TripDiaryPhoto]
}

/// A place the group stayed at without a plan.
struct TripDiaryStay: Codable, Sendable, Equatable, Identifiable {
    let visitId: Int
    let name: String?
    let osmRef: String?
    let lat: Double
    let lon: Double
    let arrivedAt: String
    let leftAt: String?
    let weather: TripVisitWeather?
    let photoCount: Int
    let photos: [TripDiaryPhoto]

    var id: Int { visitId }
    var displayName: String { name ?? "Ungeplanter Halt" }
    var coordinate: TripCoordinate { TripCoordinate(lat: lat, lon: lon) }
    /// "14:05" on this phone's clock.
    var arrivalTime: String? {
        TripInstant.parse(arrivedAt).map { TripClock.format(TripDayTimeline.minutesOfDay($0)) }
    }
}

/// `GET …/legs/:legIndex/days/:dayIndex/diary`.
struct TripDayDiary: Codable, Sendable, Equatable {
    let date: String?
    let spots: [TripDiarySpot]
    let unplanned: [TripDiaryStay]

    func spot(_ osmRef: String) -> TripDiarySpot? { spots.first { $0.osmRef == osmRef } }

    var photoCount: Int { spots.reduce(0) { $0 + $1.photoCount } + unplanned.reduce(0) { $0 + $1.photoCount } }
}

/// What "Neu ordnen" said no longer fits, and where it would go instead.
struct TripReorderAdvice: Equatable, Sendable {
    struct Move: Equatable, Sendable, Identifiable {
        let osmRef: String
        /// Within the stay; nil when no other day is left.
        let dayIndex: Int?
        let blockId: String?
        var id: String { osmRef }
    }

    let legIndex: Int
    let dayIndex: Int
    let overrunMinutes: Int
    let moves: [Move]
}

/// Past, being lived, still to come — or a trip without a date.
enum TripDayPhase: Equatable, Sendable {
    case past, running, future, undated
}

enum TripOnTheRoad {
    /// From this minute the day's open spots are asked about once.
    static let eveningMinutes = 20 * 60
    /// How long a check made by the phone says "gerade abgehakt".
    static let freshMinutes = 15
    /// Days ahead a forecast reaches.
    static let forecastDays = 7

    /// The day's date as "YYYY-MM-DD", nil without a trip date.
    static func isoDate(of dayIndex: Int, in leg: TripLeg, timeZone: TimeZone = .current) -> String? {
        guard let start = leg.startDate else { return nil }
        return TripCalendar.day(start, plus: dayIndex, timeZone: timeZone)
    }

    static func phase(of dayIndex: Int, in leg: TripLeg, today: String,
                      timeZone: TimeZone = .current) -> TripDayPhase {
        guard let date = isoDate(of: dayIndex, in: leg, timeZone: timeZone) else { return .undated }
        if date < today { return .past }
        if date == today { return .running }
        return .future
    }

    /// The stay holds the day being lived.
    static func isUnderway(_ leg: TripLeg, today: String) -> Bool {
        leg.days.contains { phase(of: $0.dayIndex, in: leg, today: today) == .running }
    }

    /// The day's stops on the road: what is settled first — done in the
    /// order it was really visited, then what was skipped — and then
    /// what is still open, in the plan's order.
    static func runningOrder(_ stops: [TripStop]) -> (settled: [TripStop], open: [TripStop]) {
        let done = stops.enumerated()
            .filter { $0.element.stopStatus == .done }
            .sorted { lhs, rhs in
                let l = lhs.element.doneAt.flatMap(TripInstant.parse)
                let r = rhs.element.doneAt.flatMap(TripInstant.parse)
                switch (l, r) {
                case let (l?, r?) where l != r: return l < r
                case (nil, _?): return false
                case (_?, nil): return true
                default: return lhs.offset < rhs.offset
                }
            }
            .map(\.element)
        let skipped = stops.filter { $0.stopStatus == .skipped }
        let open = stops.filter { $0.stopStatus == .planned }
        return (done + skipped, open)
    }

    /// The stop to go to next: the first one still open.
    static func next(_ stops: [TripStop]) -> TripStop? {
        runningOrder(stops).open.first
    }

    /// Ticked by the phone a moment ago — "gerade abgehakt", "Doch nicht".
    static func isFresh(_ stop: TripStop, now: Date) -> Bool {
        guard stop.stopStatus == .done, let doneAt = stop.doneAt, let at = TripInstant.parse(doneAt) else {
            return false
        }
        let age = now.timeIntervalSince(at)
        return age >= 0 && age <= Double(freshMinutes * 60)
    }

    /// How far what is still open runs past the day's end when started
    /// now; nil when it fits or the day has no clock.
    static func behindMinutes(_ day: TripDay, nowMinutes: Int) -> Int? {
        guard let window = day.window, nowMinutes >= window.startMinutes else { return nil }
        let open = runningOrder(TripStayPlan.stops(of: day)).open
        guard !open.isEmpty else { return nil }
        let needed = open.reduce(0) { $0 + $1.travelFromPrevious.minutes + $1.dwellMinutes + ($1.waitMinutes ?? 0) }
        let over = nowMinutes + needed - window.endMinutes
        return over > 0 ? over : nil
    }

    /// What was planned and is not going to happen any more: every open
    /// stop of a day that is over, and of the running day from the
    /// evening on.
    static func missed(_ day: TripDay, phase: TripDayPhase, nowMinutes: Int) -> [TripStop] {
        switch phase {
        case .past: break
        case .running where nowMinutes >= eveningMinutes: break
        default: return []
        }
        return runningOrder(TripStayPlan.stops(of: day)).open
    }

    /// The first day after `dayIndex` that is not over and has room for
    /// spots — where "Auf einen anderen Tag" sends a missed one.
    static func laterDay(after dayIndex: Int, in leg: TripLeg, today: String) -> TripDay? {
        leg.days
            .sorted { $0.dayIndex < $1.dayIndex }
            .first { day in
                day.dayIndex > dayIndex
                    && phase(of: day.dayIndex, in: leg, today: today) != .past
                    && TripStayPlan.dropTarget(day: day, before: nil) != nil
            }
    }

    /// A forecast exists for it: today or within a week, never before.
    static func hasForecast(_ dayIndex: Int, in leg: TripLeg, today: String) -> Bool {
        guard let date = isoDate(of: dayIndex, in: leg),
              let ahead = TripCalendar.days(from: today, to: date)
        else { return false }
        return ahead >= 0 && ahead <= forecastDays
    }

    /// A day that is over, in one line: "3 besucht · 12 Fotos".
    static func pastLine(_ day: TripDay, diary: TripDayDiary?) -> String {
        let stops = TripStayPlan.stops(of: day)
        let visited = stops.filter { $0.stopStatus == .done }.count + (diary?.unplanned.count ?? 0)
        var parts = [visited == 1 ? "1 besucht" : "\(visited) besucht"]
        let open = stops.filter { $0.stopStatus == .planned }.count
        if open > 0 { parts.append(open == 1 ? "1 nicht geschafft" : "\(open) nicht geschafft") }
        if let photos = diary?.photoCount, photos > 0 {
            parts.append(photos == 1 ? "1 Foto" : "\(photos) Fotos")
        }
        return parts.joined(separator: " · ")
    }

    /// The visits of a day in the order they happened, for the line on
    /// the map: the ticked stops and the unplanned stays.
    static func visitPath(_ day: TripDay, diary: TripDayDiary?) -> [TripCoordinate] {
        var points: [(Date, TripCoordinate)] = []
        for stop in TripStayPlan.stops(of: day) where stop.stopStatus == .done {
            if let at = stop.doneAt.flatMap(TripInstant.parse) { points.append((at, stop.coordinate)) }
        }
        for stay in diary?.unplanned ?? [] {
            if let at = TripInstant.parse(stay.arrivedAt) { points.append((at, stay.coordinate)) }
        }
        return points.sorted { $0.0 < $1.0 }.map(\.1)
    }
}
