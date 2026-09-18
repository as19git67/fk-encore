import Foundation

/// What a pin on a trip map says when you tap it (§8.3, §5.2).
///
/// Two maps use it now: the day, where a pin is a stop with a number,
/// and the pool, where it is a candidate on no day at all. The place —
/// name, sign, kind, note, links, coordinate — is the same question in
/// both; what only a planned stop has sits in `planned`, and is absent
/// rather than faked where there is no plan.
///
/// Pure, and deliberately so: the map view is a `View` and the sheet it
/// presents is layout, but *what may honestly stand in that sheet* is a
/// question with right and wrong answers — and the wrong ones are the
/// tempting ones. A pin is a place plus a position in a walking order;
/// it is **not** an appointment. The plan knows the block's hours and
/// each stop's dwell time, not the clock time of the stop itself
/// (§4.1), so this says "Vormittag · 09:00 – 12:00, etwa 1 h 30 vor
/// Ort" and never "14:20 Uhr". Inventing that hour would be a precision
/// the planner never claimed, and the slider above exists precisely to
/// let somebody check such claims.
struct TripPinDetail: Equatable {
    /// The half that belongs to a *planned* stop and to nothing else.
    ///
    /// The pool has none of it: a candidate has no number, because the
    /// pool has no order; no block, because it is on no day; and no way
    /// there, because there is no stop before it. Optional rather than
    /// filled with placeholders — "0." and "Vormittag" would be the
    /// sheet inventing a plan the spot is not part of.
    struct Planned: Equatable {
        let number: Int
        let status: TripStopStatus
        let statusLabel: String
        /// "etwa 1 h 30 vor Ort" — the dwell time, never a start time.
        let dwellText: String
        /// How you get there from the stop before, or nil for the first
        /// one and for anything the plan gave no travel time.
        let travelText: String?
        /// "Vormittag · 09:00 – 12:00", or just the block's name when
        /// the day carries no hours at all.
        let blockText: String?
        let isPinned: Bool
    }

    /// The spot's handle everywhere else — what "hide this one for the
    /// whole trip" is addressed to (§5).
    let osmRef: String
    let title: String
    /// The name on the sign where it is not the name above (§10.4).
    let localName: String?
    let category: String
    let note: String?
    let isPhotoStop: Bool
    let wikipediaUrl: URL?
    let sourceUrl: URL?
    let coordinate: TripCoordinate
    /// Where it sits in the day, or nil for a candidate in the pool
    /// (§5.2). The sheet shows what is there.
    let planned: Planned?
    /// "Strecke · 10 km · 600 Hm" for a spot whose way is the point
    /// (§4.7); nil for a place.
    var extentText: String? = nil

    /// Everything the map knows about one stop, gathered once.
    ///
    /// `day` is passed rather than a block because the caller numbers
    /// across the whole day: the pin labelled 7 has to find its own
    /// block again to say which part of the day it belongs to.
    static func of(_ stop: TripStop, number: Int, in day: TripDay) -> TripPinDetail {
        let block = day.blocks.first { block in
            block.stops.contains { $0.rowId == stop.rowId }
        }
        return TripPinDetail(
            osmRef: stop.osmRef,
            title: stop.displayName,
            localName: stop.localName.flatMap { $0 == stop.displayName ? nil : $0 },
            category: TripCategory.label(stop.category),
            note: stop.note?.trimmingCharacters(in: .whitespacesAndNewlines).nilWhenEmpty,
            isPhotoStop: stop.isPhotoStop,
            wikipediaUrl: stop.wikipediaUrl.flatMap(URL.init(string:)),
            sourceUrl: stop.sourceUrl.flatMap(URL.init(string:)),
            coordinate: stop.coordinate,
            planned: Planned(
                number: number,
                status: stop.stopStatus,
                statusLabel: stop.stopStatus.label,
                dwellText: "etwa \(TripClock.duration(max(0, stop.dwellMinutes))) vor Ort",
                travelText: travelText(stop.travelFromPrevious),
                blockText: block.map(blockText),
                isPinned: stop.pinned,
            ),
            extentText: stop.extent?.summary
        )
    }

    /// The same sheet for a candidate that is on no day yet (§5.2).
    ///
    /// Everything a place is, and nothing a plan would add. The dwell
    /// time is deliberately left out here too: on a planned stop it
    /// says how much of the block the stop eats, which is a statement
    /// about that block — in the pool the full detail screen has it,
    /// in the row where it is an estimate rather than a commitment.
    static func of(_ candidate: TripCandidate) -> TripPinDetail {
        TripPinDetail(
            osmRef: candidate.osmRef,
            title: candidate.displayName,
            localName: candidate.localName.flatMap { $0 == candidate.displayName ? nil : $0 },
            category: TripCategory.label(candidate.category),
            note: candidate.note?.trimmingCharacters(in: .whitespacesAndNewlines).nilWhenEmpty,
            isPhotoStop: candidate.isPhotoStop,
            wikipediaUrl: candidate.wikipediaUrl.flatMap(URL.init(string:)),
            sourceUrl: candidate.sourceUrl.flatMap(URL.init(string:)),
            coordinate: candidate.coordinate,
            planned: nil,
            extentText: candidate.extent?.summary
        )
    }

    /// The place in Apple Maps, named as the group knows it.
    ///
    /// Built from the coordinate rather than a search for the name: the
    /// plan already knows exactly which bench it means, and "Aussichts-
    /// punkt, ohne Namen" would find a different one every time. The
    /// name rides along only as the label.
    static func mapsURL(for detail: TripPinDetail) -> URL {
        var components = URLComponents()
        components.scheme = "https"
        components.host = "maps.apple.com"
        components.queryItems = [
            URLQueryItem(name: "ll", value: String(format: "%.6f,%.6f",
                                                  detail.coordinate.lat, detail.coordinate.lon)),
            URLQueryItem(name: "q", value: detail.title),
        ]
        // A URL built from constants and two doubles cannot fail to
        // parse; the fallback only spares every caller an optional.
        return components.url ?? URL(string: "https://maps.apple.com")!
    }

    /// "12 min zu Fuß · 900 m", or nothing when there was no travel.
    ///
    /// Zero minutes is not "0 min zu Fuß": it is the first stop of the
    /// block, or one next door, and a line saying nothing is better than
    /// a line saying nothing at length.
    private static func travelText(_ travel: TripTravel) -> String? {
        guard travel.minutes > 0 || travel.distanceM > 0 else { return nil }
        let how = travel.symbolName == "figure.walk" ? "zu Fuß" : "mit Bus oder Bahn"
        var parts = ["\(travel.minutes) min \(how)"]
        if travel.distanceM > 0 { parts.append(TripDistance.text(travel.distanceM)) }
        return parts.joined(separator: " · ")
    }

    private static func blockText(_ block: TripBlock) -> String {
        guard let start = block.startMinutes, let end = block.endMinutes else { return block.label }
        return "\(block.label) · \(TripClock.format(start)) – \(TripClock.format(end))"
    }
}

extension TripStopStatus {
    /// What the legend and the detail sheet call this state.
    ///
    /// One place, because a pin that is grey in the legend and
    /// "übersprungen" in the sheet is two features to learn instead of
    /// one.
    /// The order the legend lists them in: what most pins are first.
    static let legendOrder: [TripStopStatus] = [.planned, .done, .skipped]

    var label: String {
        switch self {
        case .planned: return "Geplant"
        case .done:    return "Erledigt"
        case .skipped: return "Ausgelassen"
        }
    }
}

/// How far, in words somebody standing there would use.
///
/// Metres below a kilometre and one decimal above it: "1,4 km" is a
/// walk you can picture, "1437 m" is a number you have to convert.
/// Its own type because three screens had grown three copies of it.
enum TripDistance {
    static func text(_ metres: Int) -> String {
        if metres < 1000 { return "\(metres) m" }
        return String(format: "%.1f km", Double(metres) / 1000)
            .replacingOccurrences(of: ".", with: ",")
    }
}

private extension String {
    var nilWhenEmpty: String? { isEmpty ? nil : self }
}
