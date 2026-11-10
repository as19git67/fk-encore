import Foundation

/// The trip as one chain of stays and journeys
/// (documentation/plans/reiseverlauf.md, stage 2).
///
/// A **stay** owns its place, its lodging, its length in days and its
/// mode on site. A **journey** owns its departure time, its arrival
/// time, its mode and the nights on the way. The **trip** owns exactly
/// one date, its first day. Every other date is derived, and the same
/// way on the phone as on the server: a stay runs from the cursor over
/// its days, the journey after it leaves on that last day and arrives
/// `nights` days later, and the next stay starts there. The screen
/// recomputes after every change, so the dates on the cards are always
/// what the server will write.
///
/// Field names mirror `trip-planner/itinerary.ts` exactly.
struct TripItineraryItem: Codable, Identifiable, Equatable, Sendable {
    enum Kind: String, Codable, Sendable {
        case stay, journey
    }

    /// The row's identity on screen only. The server knows the item by
    /// its `legId`; a new item has none until it is saved.
    var id = UUID()
    var kind: Kind
    var legId: Int?
    var title: String?

    // A stay.
    var anchor: TripCoordinate?
    var anchorLabel: String?
    /// Set while nothing is booked and the base is only a zone (§4.2).
    var anchorRadiusM: Int?
    /// How the group gets about on site; for a journey, how it travels.
    var mode: String?
    /// The departure day counts: three nights are four days.
    var days: Int?
    var radiusM: Int?
    var quartersAboard: Bool?
    var tenderPort: Bool?

    // A journey.
    /// "HH:MM", or nil while nobody knows. On the first stay this is its
    /// own arrival, when no journey leads into it.
    var departAt: String?
    var arriveAt: String?
    /// Calendar days between setting off and arriving. Zero by default.
    var nights: Int?
    /// What to keep in mind on the way: the flight number, the seat.
    var note: String?

    // What the server derived, read only.
    var startDate: String?
    var endDate: String?
    /// A stay's IANA zone, looked up from its coordinates (stage 1 of
    /// reise-planen-und-unterwegs.md). Never sent back.
    var timeZone: String?
    /// How far the clock jumps on this journey, in minutes; positive
    /// when the arrival is ahead. Never sent back.
    var zoneShiftMinutes: Int?

    enum CodingKeys: String, CodingKey {
        case kind, legId, title, anchor, anchorLabel, anchorRadiusM, mode, days, radiusM
        case quartersAboard, tenderPort, departAt, arriveAt, nights, note, startDate, endDate
        case timeZone, zoneShiftMinutes
    }

    init(kind: Kind) {
        self.kind = kind
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(Kind.self, forKey: .kind)
        legId = try c.decodeIfPresent(Int.self, forKey: .legId)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        anchor = try c.decodeIfPresent(TripCoordinate.self, forKey: .anchor)
        anchorLabel = try c.decodeIfPresent(String.self, forKey: .anchorLabel)
        anchorRadiusM = try c.decodeIfPresent(Int.self, forKey: .anchorRadiusM)
        mode = try c.decodeIfPresent(String.self, forKey: .mode)
        days = try c.decodeIfPresent(Int.self, forKey: .days)
        radiusM = try c.decodeIfPresent(Int.self, forKey: .radiusM)
        quartersAboard = try c.decodeIfPresent(Bool.self, forKey: .quartersAboard)
        tenderPort = try c.decodeIfPresent(Bool.self, forKey: .tenderPort)
        departAt = try c.decodeIfPresent(String.self, forKey: .departAt)
        arriveAt = try c.decodeIfPresent(String.self, forKey: .arriveAt)
        nights = try c.decodeIfPresent(Int.self, forKey: .nights)
        note = try c.decodeIfPresent(String.self, forKey: .note)
        startDate = try c.decodeIfPresent(String.self, forKey: .startDate)
        endDate = try c.decodeIfPresent(String.self, forKey: .endDate)
        timeZone = try c.decodeIfPresent(String.self, forKey: .timeZone)
        zoneShiftMinutes = try c.decodeIfPresent(Int.self, forKey: .zoneShiftMinutes)
    }

    /// What the server reads. Absent means "keep what is stored" for a
    /// stay that already exists, so the things this screen edits are
    /// always sent, as `null` when they were taken off — the lodging's
    /// radius once something is booked, a journey's time nobody knows
    /// any more. The derived dates are never sent back.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind)
        try c.encodeIfPresent(legId, forKey: .legId)
        try c.encode(title?.trimmingCharacters(in: .whitespacesAndNewlines), forKey: .title)
        try c.encodeIfPresent(mode, forKey: .mode)
        switch kind {
        case .stay:
            try c.encodeIfPresent(anchor, forKey: .anchor)
            try c.encode(anchorLabel, forKey: .anchorLabel)
            try c.encode(anchorRadiusM, forKey: .anchorRadiusM)
            try c.encodeIfPresent(days, forKey: .days)
            try c.encodeIfPresent(radiusM, forKey: .radiusM)
            try c.encodeIfPresent(quartersAboard, forKey: .quartersAboard)
            try c.encodeIfPresent(tenderPort, forKey: .tenderPort)
            // The first stay's own arrival; the server ignores it on
            // every other stay, where the journey before owns the time.
            try c.encode(arriveAt, forKey: .arriveAt)
        case .journey:
            try c.encode(departAt, forKey: .departAt)
            try c.encode(arriveAt, forKey: .arriveAt)
            try c.encode(nights ?? 0, forKey: .nights)
            let trimmed = note?.trimmingCharacters(in: .whitespacesAndNewlines)
            try c.encode(trimmed?.isEmpty == false ? trimmed : nil, forKey: .note)
        }
    }

    var isStay: Bool { kind == .stay }
    var isJourney: Bool { kind == .journey }

    var transportMode: TripTransportMode {
        get { mode.map(TripTransportMode.init(raw:)) ?? .foot }
        set { mode = newValue.rawValue }
    }

    /// A stay's place as the place search hands it over, or nil while
    /// nothing has been picked.
    var place: TripPlace? {
        get {
            guard let anchor else { return nil }
            return TripPlace(name: anchorLabel ?? title ?? "", subtitle: nil,
                             latitude: anchor.lat, longitude: anchor.lon)
        }
        set {
            anchor = newValue.map { TripCoordinate(lat: $0.latitude, lon: $0.longitude) }
            anchorLabel = newValue?.name
        }
    }

    /// Both times known: this journey will be a leg of its own, with
    /// days the planner fills. With one or none it only tells its
    /// neighbours what it knows.
    var isTimed: Bool { departAt != nil && arriveAt != nil }

    // MARK: - Making new links

    /// A stay with nothing picked yet, the length and mode of the stay
    /// before it: a second city on a trip you cycle through is almost
    /// certainly cycled too.
    static func newStay(like previous: TripItineraryItem?) -> TripItineraryItem {
        var stay = TripItineraryItem(kind: .stay)
        stay.days = previous?.days ?? 3
        stay.mode = previous?.mode ?? TripTransportMode.foot.rawValue
        return stay
    }

    /// A journey with its times open, between two stays or home. By
    /// car when either end gets about by car, else as the destination
    /// does: that is how the journey screen used to guess as well.
    static func newJourney(from: TripItineraryItem?, to: TripItineraryItem?) -> TripItineraryItem {
        var journey = TripItineraryItem(kind: .journey)
        let modes = [from, to].compactMap { $0?.transportMode }
        let mode: TripTransportMode = modes.contains(.car) ? .car : (to?.transportMode ?? from?.transportMode ?? .car)
        journey.mode = mode.rawValue
        journey.nights = 0
        return journey
    }
}

/// `GET /trip-planner/plans/:planId/itinerary`.
struct TripItineraryResponse: Codable, Sendable {
    let planId: Int
    let startDate: String?
    let home: TripHome?
    let items: [TripItineraryItem]
}

/// `PUT /trip-planner/plans/:planId/itinerary`: the whole chain.
struct TripItineraryRequest: Encodable {
    let startDate: String?
    let items: [TripItineraryItem]

    enum CodingKeys: String, CodingKey { case startDate, items }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        // Required on the wire, null to take the dates off.
        try c.encode(startDate, forKey: .startDate)
        try c.encode(items, forKey: .items)
    }
}

/// One item with the dates the chain gives it.
struct TripItineraryDated: Equatable {
    let item: TripItineraryItem
    let startDate: String?
    let endDate: String?
}

/// Where the itinerary screen opens unfolded when it is entered from
/// somewhere in the plan (stage 3): the leg sheet names its leg, the
/// day's frame band names the journey that wrote the time it shows.
enum TripItineraryFocus: Hashable, Identifiable {
    /// The card of this leg — a stay, or a journey with both times.
    case leg(Int)
    /// The journey that arrives at this stay.
    case journeyBefore(legId: Int)
    /// The journey that leaves this stay.
    case journeyAfter(legId: Int)

    var id: Self { self }
}

/// The chain as the screen edits it, and the arithmetic that keeps it
/// a chain: stays and journeys alternate, home at both ends means a
/// journey at both ends, and every date follows from the first.
///
/// A value type apart from the view so the rules — what inserting,
/// removing and moving a stay do to the journeys around it, which dates
/// come out — are testable without a running app.
struct TripItineraryDraft: Equatable {
    /// The trip's one date, as `YYYY-MM-DD`, or nil for "some time".
    var startDate: String?
    /// Whether the trip knows where home is: then the way there and the
    /// way home are journeys of the chain.
    var hasHome: Bool
    var homeLabel: String
    private(set) var items: [TripItineraryItem]

    /// Mirrors `itinerary.ts`.
    static let maxStays = 20
    static let minStayDays = 1
    static let maxStayDays = 14
    static let maxJourneyNights = 6
    /// A ship's sea days are its nights on the way; a cruise before its
    /// ports are put in is one long ship journey.
    static let maxShipNights = 30

    /// How many nights a journey of this mode may have.
    static func maxNights(for mode: TripTransportMode) -> Int {
        mode == .ship ? maxShipNights : maxJourneyNights
    }

    init(startDate: String?, hasHome: Bool, homeLabel: String = "Zuhause", items: [TripItineraryItem]) {
        self.startDate = startDate
        self.hasHome = hasHome
        self.homeLabel = homeLabel
        self.items = items
        normalise()
    }

    init(response: TripItineraryResponse) {
        self.init(startDate: response.startDate, hasHome: response.home != nil,
                  homeLabel: response.home?.displayLabel ?? "Zuhause", items: response.items)
    }

    // MARK: - Reading

    var stays: [TripItineraryItem] { items.filter(\.isStay) }
    var stayCount: Int { items.filter(\.isStay).count }
    var canAddStay: Bool { stayCount < Self.maxStays }

    func index(of id: TripItineraryItem.ID) -> Int? {
        items.firstIndex { $0.id == id }
    }

    /// The stay before this journey, or nil for home.
    func stay(before id: TripItineraryItem.ID) -> TripItineraryItem? {
        guard let i = index(of: id), i > 0 else { return nil }
        return items[i - 1].isStay ? items[i - 1] : nil
    }

    /// The stay after this journey, or nil for home.
    func stay(after id: TripItineraryItem.ID) -> TripItineraryItem? {
        guard let i = index(of: id), i + 1 < items.count else { return nil }
        return items[i + 1].isStay ? items[i + 1] : nil
    }

    /// The journey that arrives at this stay, or nil when the stay
    /// opens the chain.
    func journey(before stayId: TripItineraryItem.ID) -> TripItineraryItem? {
        guard let i = index(of: stayId), i > 0, items[i - 1].isJourney else { return nil }
        return items[i - 1]
    }

    /// The journey that leaves this stay, or nil when it closes the chain.
    func journey(after stayId: TripItineraryItem.ID) -> TripItineraryItem? {
        guard let i = index(of: stayId), i + 1 < items.count, items[i + 1].isJourney else { return nil }
        return items[i + 1]
    }

    /// A stay with a ship on both sides sleeps aboard, whatever its
    /// fields say: the server reads it the same way (`betweenShips` in
    /// `itinerary.ts`).
    func isBetweenShips(_ stayId: TripItineraryItem.ID) -> Bool {
        guard let before = journey(before: stayId), let after = journey(after: stayId) else { return false }
        return before.transportMode == .ship && after.transportMode == .ship
    }

    /// Whether this stay's "Von" is the trip's one date: it opens the
    /// chain, so no journey before it owns a day (plan, "The model").
    func ownsStart(_ id: TripItineraryItem.ID) -> Bool {
        items.first?.id == id
    }

    /// The way there from home, when the trip knows home.
    var outbound: TripItineraryItem? {
        items.first?.isJourney == true ? items.first : nil
    }

    /// "Anreise", "Heimreise", "Schiff" or "Weiterreise": what a journey
    /// is called on its card and on its sheet.
    func name(of journey: TripItineraryItem) -> String {
        if stay(before: journey.id) == nil { return "Anreise" }
        if stay(after: journey.id) == nil { return "Heimreise" }
        return journey.transportMode == .ship ? "Schiff" : "Weiterreise"
    }

    /// How many days the trip has in all, counted the way the cards
    /// count them.
    var totalDays: Int {
        (TripItineraryText.dayOffsets(of: self).last?.last ?? 0) + 1
    }

    /// The item a way into the screen points at (stage 3): a leg's own
    /// card, or the journey on one side of a stay.
    ///
    /// A journey into the first stay that has no journey before it (no
    /// home known) is the stay's own arrival, so the stay is answered;
    /// the same for a departure after the last stay. A stay the plan no
    /// longer has answers nil and the screen opens folded.
    func item(focused focus: TripItineraryFocus) -> TripItineraryItem? {
        switch focus {
        case .leg(let legId):
            return items.first { $0.legId == legId }
        case .journeyBefore(let legId):
            guard let i = items.firstIndex(where: { $0.legId == legId }) else { return nil }
            return i > 0 && items[i - 1].isJourney ? items[i - 1] : items[i]
        case .journeyAfter(let legId):
            guard let i = items.firstIndex(where: { $0.legId == legId }) else { return nil }
            return i + 1 < items.count && items[i + 1].isJourney ? items[i + 1] : items[i]
        }
    }

    /// What to call a stay: its name, its lodging, or which one it is.
    /// Never invents a name (§15.3).
    func title(of item: TripItineraryItem) -> String {
        if let title = item.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { return title }
        if let label = item.anchorLabel?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty { return label }
        let number = (stays.firstIndex { $0.id == item.id } ?? 0) + 1
        return "Aufenthalt \(number)"
    }

    /// Where a journey comes from and goes to, in words.
    func ends(of journey: TripItineraryItem) -> (from: String, to: String) {
        (stay(before: journey.id).map(title(of:)) ?? homeLabel,
         stay(after: journey.id).map(title(of:)) ?? homeLabel)
    }

    /// Every item with its dates: the cursor walks the chain from the
    /// first day. Nil everywhere while the trip has no date.
    func dated(timeZone: TimeZone = .current) -> [TripItineraryDated] {
        var cursor = startDate
        return items.map { item in
            let start = cursor
            let end: String?
            if item.isStay {
                end = cursor.flatMap { TripCalendar.day($0, plus: max(1, item.days ?? 1) - 1, timeZone: timeZone) }
            } else {
                end = cursor.flatMap { TripCalendar.day($0, plus: max(0, item.nights ?? 0), timeZone: timeZone) }
            }
            cursor = end
            return TripItineraryDated(item: item, startDate: start, endDate: end)
        }
    }

    /// The day after the whole trip — the last stay's last day, or the
    /// day the way home arrives. Nil without a date.
    var lastDate: String? { dated().last?.endDate }

    /// Why the chain cannot be saved yet, one sentence each; empty when
    /// it can. The same refusals the server would give, said before.
    func problems() -> [String] {
        var found: [String] = []
        if stayCount == 0 {
            found.append("Eine Reise hat mindestens einen Aufenthalt.")
        }
        for (position, stay) in stays.enumerated() where stay.anchor == nil {
            found.append("Aufenthalt \(position + 1) hat noch keinen Ort.")
        }
        for journey in items where journey.isJourney {
            if (journey.nights ?? 0) == 0,
               let depart = journey.departAt.flatMap(TripClock.minutes(fromClock:)),
               let arrive = journey.arriveAt.flatMap(TripClock.minutes(fromClock:)),
               arrive <= depart {
                let (from, to) = ends(of: journey)
                found.append("Die Weiterreise von \(from) nach \(to) kommt an, bevor sie abfährt — "
                             + "oder sie kommt erst am nächsten Tag an.")
            }
        }
        return found
    }

    var request: TripItineraryRequest {
        TripItineraryRequest(startDate: startDate, items: items)
    }

    // MARK: - Changing

    /// Read or change one item by id. A write to an id that is gone is
    /// dropped: SwiftUI evaluates a row once more on its way out.
    subscript(id: TripItineraryItem.ID) -> TripItineraryItem? {
        get { items.first { $0.id == id } }
        set {
            guard let newValue, let i = index(of: id) else { return }
            items[i] = newValue
        }
    }

    /// Add a stay after the given one, or at the very beginning for
    /// nil. The journey into it comes in the same step, times open,
    /// so the chain never has two stays side by side.
    @discardableResult
    mutating func insertStay(after stayId: TripItineraryItem.ID?) -> TripItineraryItem.ID {
        if let stayId, let i = index(of: stayId), items[i].isStay {
            let previous = items[i]
            let stay = TripItineraryItem.newStay(like: previous)
            let journey = TripItineraryItem.newJourney(from: previous, to: stay)
            items.insert(contentsOf: [journey, stay], at: i + 1)
            normalise()
            return stay.id
        }
        guard let firstStayIndex = items.firstIndex(where: \.isStay) else {
            let stay = TripItineraryItem.newStay(like: nil)
            items = [stay]
            normalise()
            return stay.id
        }
        let first = items[firstStayIndex]
        let stay = TripItineraryItem.newStay(like: first)
        let journey = TripItineraryItem.newJourney(from: stay, to: first)
        items.insert(contentsOf: [stay, journey], at: firstStayIndex)
        normalise()
        return stay.id
    }

    /// Take a stay out. The two journeys around it become one: the
    /// way in keeps its departure, and takes the way out's arrival.
    mutating func removeStay(id: TripItineraryItem.ID) {
        guard let i = index(of: id), items[i].isStay, stayCount > 1 else { return }
        let before = i > 0 && items[i - 1].isJourney ? i - 1 : nil
        let after = i + 1 < items.count && items[i + 1].isJourney ? i + 1 : nil
        switch (before, after) {
        case let (b?, a?):
            var merged = items[b]
            merged.arriveAt = items[a].arriveAt
            merged.nights = max(merged.nights ?? 0, items[a].nights ?? 0)
            items[b] = merged
            items.removeSubrange(i...a)
        case let (nil, a?):
            items.removeSubrange(i...a)
        case let (b?, nil):
            items.removeSubrange(b...i)
        case (nil, nil):
            items.remove(at: i)
        }
        normalise()
    }

    /// Take what was said about a journey off: its mode, times, nights
    /// and note. Between two stays the journey itself stays — something
    /// has to bring the group from one to the next — and with home the
    /// way there and the way home do too; they only go back to "Zeiten
    /// noch offen".
    mutating func clearJourney(id: TripItineraryItem.ID) {
        guard let i = index(of: id), items[i].isJourney else { return }
        var cleared = TripItineraryItem.newJourney(from: stay(before: id), to: stay(after: id))
        cleared.id = items[i].id
        cleared.legId = items[i].legId
        items[i] = cleared
    }

    /// Whether anything about this journey is kept: a time, nights on
    /// the way or a note. Its mode alone is not; without times the
    /// server keeps no row for it.
    func hasDetails(_ id: TripItineraryItem.ID) -> Bool {
        guard let journey = self[id] else { return false }
        return journey.departAt != nil || journey.arriveAt != nil || (journey.nights ?? 0) != 0
            || !(journey.note ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Reorder the stays as a list does. The journeys keep their
    /// slots: the one that sits between the first and the second stay
    /// still does, whichever stays those are now.
    mutating func moveStays(fromOffsets: IndexSet, toOffset: Int) {
        var stays = self.stays
        stays.move(fromOffsets: fromOffsets, toOffset: toOffset)
        let journeys = items.filter(\.isJourney)
        let leading = items.first?.isJourney == true
        var rebuilt: [TripItineraryItem] = []
        var j = journeys.makeIterator()
        if leading, let first = j.next() { rebuilt.append(first) }
        for stay in stays {
            rebuilt.append(stay)
            if let journey = j.next() { rebuilt.append(journey) }
        }
        items = rebuilt
        normalise()
    }

    /// One stay up or down by one place, from a button on its card:
    /// the list's edit mode asked for a tap on a pencil nobody could
    /// place. Nothing happens at either end.
    mutating func moveStay(id: TripItineraryItem.ID, up: Bool) {
        let stays = self.stays
        guard let position = stays.firstIndex(where: { $0.id == id }) else { return }
        let target = up ? position - 1 : position + 2
        guard target >= 0, target <= stays.count else { return }
        moveStays(fromOffsets: IndexSet(integer: position), toOffset: target)
    }

    /// Put a port into a ship journey (plan, "Cruises"): the journey is
    /// split around a stay, and the end of the trip stays where it was.
    ///
    /// `ashoreAfter` is how many nights after setting off the ship
    /// docks, `days` how many calendar days the port lasts (the day the
    /// ship leaves again counts), `ashoreFrom` and `aboardUntil` the
    /// clock times. The first half keeps the journey's id and departure,
    /// the second half its arrival and whatever nights are left. Nil
    /// when the port does not fit inside the journey, or when a time on
    /// the same day would run backwards.
    @discardableResult
    mutating func insertPort(into journeyId: TripItineraryItem.ID, ashoreAfter: Int, days: Int,
                             ashoreFrom: String?, aboardUntil: String?) -> TripItineraryItem.ID? {
        guard let i = index(of: journeyId), items[i].isJourney, canAddStay,
              ashoreAfter >= 0, days >= Self.minStayDays, days <= Self.maxStayDays
        else { return nil }
        let journey = items[i]
        let nights = journey.nights ?? 0
        let rest = nights - ashoreAfter - (days - 1)
        guard rest >= 0 else { return nil }
        let clock = { (text: String?) in text.flatMap(TripClock.minutes(fromClock:)) }
        if ashoreAfter == 0, let depart = clock(journey.departAt), let ashore = clock(ashoreFrom), ashore <= depart {
            return nil
        }
        if days == 1, let ashore = clock(ashoreFrom), let aboard = clock(aboardUntil), aboard <= ashore {
            return nil
        }
        if rest == 0, let aboard = clock(aboardUntil), let arrive = clock(journey.arriveAt), arrive <= aboard {
            return nil
        }
        var first = journey
        first.arriveAt = ashoreFrom
        first.nights = ashoreAfter
        var port = TripItineraryItem(kind: .stay)
        port.days = days
        port.mode = TripTransportMode.foot.rawValue
        var second = TripItineraryItem(kind: .journey)
        second.mode = journey.mode
        second.departAt = aboardUntil
        second.arriveAt = journey.arriveAt
        second.nights = rest
        items.replaceSubrange(i...i, with: [first, port, second])
        normalise()
        return port.id
    }

    /// Home came or went: the way there and the way home with it.
    mutating func setHome(_ label: String?) {
        hasHome = label != nil
        homeLabel = label ?? "Zuhause"
        normalise()
    }

    /// Keep the chain a chain: stays and journeys alternate; with home
    /// a journey at both ends, without one none. A trip written before
    /// the chain existed may come back without a leading journey
    /// although it has a home — it gets one with its times open, which
    /// writes nothing until somebody fills it in.
    private mutating func normalise() {
        var fixed: [TripItineraryItem] = []
        for item in items {
            if let last = fixed.last, last.kind == item.kind {
                if item.isStay {
                    fixed.append(TripItineraryItem.newJourney(from: last, to: item))
                } else {
                    // Two journeys in a row: keep the first, it has the id.
                    continue
                }
            }
            fixed.append(item)
        }
        while let first = fixed.first, first.isJourney, !hasHome { fixed.removeFirst() }
        while let last = fixed.last, last.isJourney, !hasHome { fixed.removeLast() }
        if hasHome, let first = fixed.first, first.isStay {
            fixed.insert(TripItineraryItem.newJourney(from: nil, to: first), at: 0)
        }
        if hasHome, let last = fixed.last, last.isStay {
            fixed.append(TripItineraryItem.newJourney(from: last, to: nil))
        }
        items = fixed
    }
}

/// The words on the cards, apart so they can be tested.
enum TripItineraryText {
    /// "4 Tage · 3 Nächte": both are everyday language, and the
    /// departure day belongs to the stay (plan, "Decisions taken").
    static func stayLength(days: Int) -> String {
        let dayWord = days == 1 ? "1 Tag" : "\(days) Tage"
        let nights = max(0, days - 1)
        let nightWord = nights == 0 ? "keine Nacht" : nights == 1 ? "1 Nacht" : "\(nights) Nächte"
        return "\(dayWord) · \(nightWord)"
    }

    /// "ab 10:00 · an 15:00 · mit dem Auto", "Zeiten offen · mit der
    /// Bahn", with the nights on the way when there are any.
    static func journeyLine(_ journey: TripItineraryItem) -> String {
        var parts: [String] = []
        switch (journey.departAt, journey.arriveAt) {
        case let (depart?, arrive?): parts.append("ab \(depart) · an \(arrive)")
        case let (depart?, nil): parts.append("ab \(depart) · Ankunft offen")
        case let (nil, arrive?): parts.append("Abfahrt offen · an \(arrive)")
        case (nil, nil): parts.append("Zeiten offen")
        }
        parts.append(journey.transportMode.label)
        if let nights = journey.nights, nights > 0 {
            parts.append(arrival(nights: nights))
        }
        return parts.joined(separator: " · ")
    }

    /// When the journey arrives, counted in days from setting off.
    /// "1 Nacht unterwegs" read as driving through the night; what the
    /// number means is that the arrival is a day later.
    static func arrival(nights: Int) -> String {
        switch nights {
        case ...0: return "Ankunft am selben Tag"
        case 1: return "Ankunft am nächsten Tag"
        default: return "Ankunft \(nights) Tage später"
        }
    }

    /// "+8 h", "−7 h", "+5 h 30": the jump of the clock on a journey
    /// that crosses zones. Nil when it does not jump.
    static func zoneShift(_ minutes: Int?) -> String? {
        guard let minutes, minutes != 0 else { return nil }
        let sign = minutes > 0 ? "+" : "−"
        let hours = abs(minutes) / 60
        let rest = abs(minutes) % 60
        return rest == 0 ? "\(sign)\(hours) h" : "\(sign)\(hours) h \(rest)"
    }

    /// The trip under its name: "Fr 27.11. bis Do 3.12.2026 · 7 Tage",
    /// or "Noch ohne Datum · 7 Tage".
    static func tripSpan(_ draft: TripItineraryDraft, timeZone: TimeZone = .current) -> String {
        let days = draft.totalDays
        let length = days == 1 ? "1 Tag" : "\(days) Tage"
        guard let start = draft.startDate, let end = draft.lastDate else { return "Noch ohne Datum · \(length)" }
        return "\(shortDate(start, timeZone: timeZone)) bis \(longDate(end, timeZone: timeZone)) · \(length)"
    }

    /// "Do 3.12.2026": the end of a trip, with its year.
    static func longDate(_ isoDay: String, timeZone: TimeZone = .current) -> String {
        guard let date = TripCalendar.date(fromIsoDay: isoDay, timeZone: timeZone) else { return isoDay }
        let formatter = DateFormatter()
        formatter.timeZone = timeZone
        formatter.setLocalizedDateFormatFromTemplate("EEE d. MMM yyyy")
        return formatter.string(from: date)
    }

    /// "Mo, 3.6." — short enough for a card, in the phone's own words.
    static func shortDate(_ isoDay: String, timeZone: TimeZone = .current) -> String {
        guard let date = TripCalendar.date(fromIsoDay: isoDay, timeZone: timeZone) else { return isoDay }
        let formatter = DateFormatter()
        formatter.timeZone = timeZone
        formatter.setLocalizedDateFormatFromTemplate("EEE d. MMM")
        return formatter.string(from: date)
    }

    /// "Mo, 3.6. – Mi, 5.6." or "Mo, 3.6." for one day; "Tag 1 – 3"
    /// while the trip has no date.
    static func span(_ dated: TripItineraryDated, dayOffsets: (first: Int, last: Int),
                     timeZone: TimeZone = .current) -> String {
        if let start = dated.startDate, let end = dated.endDate {
            return start == end
                ? shortDate(start, timeZone: timeZone)
                : "\(shortDate(start, timeZone: timeZone)) – \(shortDate(end, timeZone: timeZone))"
        }
        return dayOffsets.first == dayOffsets.last
            ? "Tag \(dayOffsets.first + 1)"
            : "Tag \(dayOffsets.first + 1) – \(dayOffsets.last + 1)"
    }

    /// Which days of the trip every item covers, counted from the first
    /// day, for a trip that has no date yet. Returned alongside the
    /// dates so both spellings come from the same walk.
    static func dayOffsets(of draft: TripItineraryDraft) -> [(first: Int, last: Int)] {
        var cursor = 0
        return draft.items.map { item in
            let first = cursor
            let last = item.isStay ? cursor + max(1, item.days ?? 1) - 1 : cursor + max(0, item.nights ?? 0)
            cursor = last
            return (first, last)
        }
    }
}

/// The planner's one suggestion for a journey (§22.7), as the server
/// sends it. Writes nothing until it is taken into the chain.
struct TripTransitSuggestion: Codable, Sendable, Equatable {
    let afterLegIndex: Int
    let fromTitle: String
    let toTitle: String
    let departDate: String?
    let departAt: String
    let arriveDate: String?
    let arriveAt: String
    let mode: String
    let driveMinutes: Int
    let sentence: String

    /// A "no" is remembered on this phone: nothing was written that
    /// could be taken back, so there is nothing to tell the server.
    static func dismissKey(planId: Int, afterLegIndex: Int) -> String {
        "trip.transitSuggestion.dismissed.\(planId).\(afterLegIndex)"
    }
}

struct TripTransitSuggestionResponse: Codable, Sendable {
    let suggestion: TripTransitSuggestion?
}

/// One day under a stay in the itinerary (reise-planen-und-unterwegs.md,
/// stage 2): which day, what is in it, and how full it is — the same
/// figure the stay's planning view shows as "planned of available".
struct TripItineraryDayRow: Identifiable, Equatable {
    /// The day's index within its leg, as the plan numbers it; nil for
    /// a day the server has not written yet (a stay just lengthened).
    let dayIndex: Int?
    /// Counted from one within the stay.
    let number: Int
    /// "Tag 1 · Fr., 27. Nov. · an 12:30".
    let label: String
    /// "2 Spots", "noch frei", "zu viel", "keine Zeit frei".
    let summary: String
    /// 0…1, above 1 when the day runs over; nil when the day has no
    /// clock to measure against.
    let fill: Double?

    var id: Int { number }
    var isOverfull: Bool { (fill ?? 0) > 1 }
}

enum TripItineraryDays {
    /// The rows under a stay. `days` are the stay's days as the plan has
    /// them, empty while it is not saved; `arrival` and `departure` are the times of
    /// the journeys on either side, which shorten the first and the
    /// last day.
    static func rows(stay: TripItineraryItem, dated: TripItineraryDated, days planned: [TripDay],
                     arrival: String?, departure: String?,
                     timeZone: TimeZone = .current) -> [TripItineraryDayRow] {
        let count = max(1, stay.days ?? 1)
        let days = planned.sorted { $0.dayIndex < $1.dayIndex }
        return (0..<count).map { offset in
            let day = offset < days.count ? days[offset] : nil
            var parts = ["Tag \(offset + 1)"]
            if let start = dated.startDate, let date = TripCalendar.day(start, plus: offset, timeZone: timeZone) {
                parts.append(TripItineraryText.shortDate(date, timeZone: timeZone))
            }
            if offset == 0, let arrival { parts.append("an \(arrival)") }
            if offset == count - 1, let departure { parts.append("ab \(departure)") }
            let spots = day?.blocks.reduce(0) { $0 + $1.stops.count } ?? 0
            let fill: Double?
            if let window = day?.window, window.minutes > 0 {
                fill = Double(day?.plannedMinutes ?? 0) / Double(window.minutes)
            } else {
                fill = spots == 0 ? 0 : nil
            }
            let summary: String
            if let day, spots == 0, TripStayPlan.hasNoTime(day) {
                summary = "keine Zeit frei"
            } else if (day?.overrunMinutes ?? 0) > 0 || (fill ?? 0) > 1 {
                summary = "zu viel"
            } else if spots == 0 {
                summary = "noch frei"
            } else {
                summary = spots == 1 ? "1 Spot" : "\(spots) Spots"
            }
            return TripItineraryDayRow(dayIndex: day?.dayIndex, number: offset + 1,
                                       label: parts.joined(separator: " · "), summary: summary, fill: fill)
        }
    }
}
