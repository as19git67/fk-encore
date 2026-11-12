import Foundation

// What the spot picker adds to (reise-planen-und-unterwegs.md, Mock 17):
// the stay around the quarters, one excursion's time window, or a whole
// day out. The bar "Für" at the top of the picker names it; "Ändern"
// offers the others. The search goes around the target's destination,
// "+" puts a spot into its window, and the ideas near the destination
// come first.

/// One thing the picker can add to.
struct TripPickerTarget: Identifiable, Equatable, Sendable {
    enum Kind: Equatable, Sendable { case stay, excursion, dayTrip }

    let kind: Kind
    /// The day of an excursion or a day out; for the stay the day "+"
    /// adds to when the picker opened from one, else nil.
    let dayIndex: Int?
    /// "Seestadt": the destination, or the stay's name.
    let name: String
    /// "Ausflug nach Seestadt", "Ganzer Tag in Großstadt", "Bergdorf".
    let title: String
    /// Where the search goes; nil searches around the quarters.
    let area: TripSearchArea?
    /// The excursion's window; nil for the stay and a day out.
    let blockId: String?
    /// "10:40–13:00": the time at the destination, for an excursion.
    let window: String?
    /// What the window still holds, for an excursion.
    let freeMinutes: Int?

    var id: String {
        switch kind {
        case .stay: dayIndex.map { "stay-\($0)" } ?? "stay"
        case .excursion: blockId ?? "excursion"
        case .dayTrip: "day-\(dayIndex ?? -1)"
        }
    }

    /// The day "+" adds to and the window it adds into, as the picker
    /// already keeps it.
    var focus: TripDayTripFocus? {
        guard let dayIndex else { return nil }
        return TripDayTripFocus(dayIndex: dayIndex, name: name, blockId: blockId)
    }

    /// The second line of the bar and of a row under "Ändern".
    var line: String {
        switch kind {
        case .stay:
            return dayIndex == nil ? "der Aufenthalt, um die Unterkunft" : "um die Unterkunft"
        case .excursion:
            var parts: [String] = []
            if let window { parts.append(window) }
            if let free = freeMinutes { parts.append(TripPickerTargets.freeText(free)) }
            return parts.joined(separator: " · ")
        case .dayTrip:
            return "ganztägiger Ausflug"
        }
    }

    /// "Tag 3 · 10:40–13:00 · noch 1 h 20 frei": the bar names the day too.
    var barLine: String {
        guard let dayIndex else { return line }
        return "Tag \(dayIndex + 1) · \(line)"
    }

    /// "In Seestadt suchen", the prompt of the search field.
    var searchPrompt: String {
        kind == .stay ? "Name, Kategorie oder Karten-Link" : "In \(name) suchen"
    }

    /// What VoiceOver says for "+" on a row added here.
    var addLabel: String {
        switch kind {
        case .stay: dayIndex.map { "Auf Tag \($0 + 1) legen" } ?? "Hinzufügen"
        case .excursion: "In den Ausflug nach \(name)"
        case .dayTrip: "Auf Tag \((dayIndex ?? 0) + 1) in \(name) legen"
        }
    }
}

/// The targets of a day, for the list under "Ändern".
struct TripPickerTargetDay: Identifiable, Sendable {
    let dayIndex: Int
    let title: String
    let targets: [TripPickerTarget]
    var id: Int { dayIndex }
}

enum TripPickerTargets {
    /// A spot within this of an excursion's destination is "am Ziel".
    static let atDestinationM = 150.0

    /// The stay itself; with `day`, one of its days at the quarters,
    /// for a picker opened from that day.
    static func stay(_ leg: TripLeg, day: Int? = nil) -> TripPickerTarget {
        TripPickerTarget(kind: .stay, dayIndex: day, name: leg.displayTitle, title: leg.displayTitle,
                         area: nil, blockId: nil, window: nil, freeMinutes: nil)
    }

    /// An excursion of a day: its window at the destination and what is
    /// left of it.
    static func excursion(_ excursion: TripExcursion, on day: TripDay) -> TripPickerTarget {
        let arrive = excursion.departMinutes + excursion.travelMinutes
        let window = "\(TripClock.format(arrive))–\(TripClock.format(excursion.returnMinutes))"
        let block = day.blocks.first { $0.id == excursion.blockId }
        let free = block.map { max(0, $0.budgetMinutes - $0.usedMinutes) }
            ?? max(0, excursion.returnMinutes - arrive)
        return TripPickerTarget(
            kind: .excursion, dayIndex: day.dayIndex, name: excursion.displayName, title: excursion.title,
            area: TripSearchArea(lat: excursion.lat, lon: excursion.lon,
                                 radiusM: Double(excursion.radiusM ?? 3_000)),
            blockId: excursion.blockId, window: window, freeMinutes: free)
    }

    /// A day spent elsewhere as a whole, when the day has one.
    static func dayTrip(_ day: TripDay) -> TripPickerTarget? {
        guard let anchor = day.anchor else { return nil }
        let name = anchor.label?.trimmingCharacters(in: .whitespacesAndNewlines)
        let place = name?.isEmpty == false ? name! : "Ausflug"
        return TripPickerTarget(
            kind: .dayTrip, dayIndex: day.dayIndex, name: place,
            title: name?.isEmpty == false ? "Ganzer Tag in \(place)" : "Ganztägiger Ausflug",
            area: TripSearchArea(lat: anchor.lat, lon: anchor.lon, radiusM: Double(anchor.radiusM ?? 3_000)),
            blockId: nil, window: nil, freeMinutes: nil)
    }

    /// Every day with an excursion or a day out, in day order. A day
    /// without one is not listed: it sits in the stay.
    static func days(of leg: TripLeg) -> [TripPickerTargetDay] {
        leg.days.sorted { $0.dayIndex < $1.dayIndex }.compactMap { day in
            let targets = (day.excursions ?? []).map { excursion($0, on: day) }
                + [dayTrip(day)].compactMap { $0 }
            guard !targets.isEmpty else { return nil }
            return TripPickerTargetDay(dayIndex: day.dayIndex, title: TripStayPlan.dayTitle(day, leg: leg),
                                       targets: targets)
        }
    }

    /// Every target that is not the stay.
    static func away(of leg: TripLeg) -> [TripPickerTarget] {
        days(of: leg).flatMap(\.targets)
    }

    /// The target as it stands in the plan now: a reload changes what
    /// the window still holds, or takes the excursion away.
    static func refreshed(_ target: TripPickerTarget, in leg: TripLeg?) -> TripPickerTarget? {
        guard let leg else { return nil }
        if target.kind == .stay {
            let day = target.dayIndex.flatMap { index in leg.days.contains { $0.dayIndex == index } ? index : nil }
            return stay(leg, day: day)
        }
        return away(of: leg).first { $0.id == target.id }
    }

    /// The excursion or day out a place lies at, when the picker adds to
    /// the stay: the nearest whose search circle holds it.
    static func near(_ coordinate: TripCoordinate, in targets: [TripPickerTarget]) -> TripPickerTarget? {
        targets
            .compactMap { target -> (TripPickerTarget, Double)? in
                guard let area = target.area else { return nil }
                let metres = TripBallotDetails.metresBetween(
                    TripCoordinate(lat: area.lat, lon: area.lon), coordinate)
                return metres <= area.radiusM ? (target, metres) : nil
            }
            .min { $0.1 < $1.1 }?.0
    }

    /// Ideas near the destination first (its search circle), then the
    /// rest of the stay's, each in the order they came.
    static func splitIdeas(_ ideas: [TripPickerItem], around target: TripPickerTarget)
        -> (near: [TripPickerItem], rest: [TripPickerItem]) {
        guard let area = target.area else { return (ideas, []) }
        let centre = TripCoordinate(lat: area.lat, lon: area.lon)
        let near = ideas
            .map { ($0, TripBallotDetails.metresBetween(centre, $0.coordinate)) }
            .filter { $0.1 <= area.radiusM }
            .sorted { $0.1 < $1.1 }
            .map(\.0)
        let nearIds = Set(near.map(\.id))
        return (near, ideas.filter { !nearIds.contains($0.id) })
    }

    /// "600 m vom Ziel", "2 km vom Ziel", "am Ziel".
    static func fromDestination(_ coordinate: TripCoordinate, _ target: TripPickerTarget) -> String? {
        guard let area = target.area else { return nil }
        let metres = TripBallotDetails.metresBetween(TripCoordinate(lat: area.lat, lon: area.lon), coordinate)
        if metres < atDestinationM { return "am Ziel" }
        return "\(TripDistance.text(Int(metres.rounded()))) vom Ziel"
    }

    /// True when a spot takes longer than the window still holds: its
    /// row is pale, "+" still adds it (the section then says "zu viel").
    static func doesNotFit(dwellMinutes: Int?, _ target: TripPickerTarget) -> Bool {
        guard let free = target.freeMinutes, let dwell = dwellMinutes else { return false }
        return dwell > free
    }

    /// "noch 1 h 20 frei", "nichts mehr frei".
    static func freeText(_ minutes: Int) -> String {
        minutes <= 0 ? "nichts mehr frei" : "noch \(TripClock.duration(minutes)) frei"
    }

    /// "passt nicht, 1 h 20 frei" on a pale row.
    static func misfitText(_ target: TripPickerTarget) -> String {
        guard let free = target.freeMinutes, free > 0 else { return "passt nicht, nichts mehr frei" }
        return "passt nicht, \(TripClock.duration(free)) frei"
    }

    /// "nahe Seestadt · Ausflug Tag 3" on a row of the stay's list.
    static func nearText(_ target: TripPickerTarget) -> String {
        let day = target.dayIndex.map { " Tag \($0 + 1)" } ?? ""
        return "nahe \(target.name) · Ausflug\(day)"
    }
}
