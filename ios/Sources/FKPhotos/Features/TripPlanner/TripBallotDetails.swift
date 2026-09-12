import Foundation

/// What a row of the ballot can say about the place it asks about
/// (§6.1, §3.8).
///
/// The list used to show a name, the voices and four buttons. Voting on
/// a name is voting on a word: "Palazzo Vecchio" tells somebody who has
/// not read the guidebook neither what it is nor whether it is round
/// the corner or across the city — and the answer to both was already
/// in the plan, one screen away, unasked.
///
/// So the row answers **what** and **where**, and the ballot itself
/// needed nothing new for it: every spot up for a vote is either a stop
/// on a day or an entry in the leg's pool, and both carry all of this
/// already. Sending it a second time in the ballot response would be
/// two sources for one fact, and the one on screen would be the one
/// nobody planned with.
enum TripBallotDetails {

    /// Everything the row shows, and what a tap opens.
    struct Details {
        /// The stop or the pool entry behind the vote, for the detail
        /// screen. Nil when the ballot names something the leg no
        /// longer has — a spot somebody dropped between two loads.
        let spot: TripSpotDetail?
        /// "Museum · 1 h 30 · Tag 2, Vormittag", as far as it is known.
        let line: String
        /// What somebody wrote next to it, which is the part that
        /// actually decides an afternoon (§9.2).
        let note: String?
    }

    /// The row's answer, out of the leg the ballot belongs to.
    static func of(_ osmRef: String, in leg: TripLeg) -> Details {
        if let placed = placed(osmRef, in: leg) {
            let spot = TripSpotDetail(placed.stop)
            return Details(
                spot: spot,
                line: line(category: spot.category,
                           dwellMinutes: spot.dwellMinutes,
                           where: "\(placed.dayLabel), \(placed.blockLabel)"),
                note: cleaned(spot.note),
            )
        }
        if let candidate = leg.pool.first(where: { $0.osmRef == osmRef }) {
            let spot = TripSpotDetail(candidate)
            return Details(
                spot: spot,
                line: line(category: spot.category,
                           dwellMinutes: spot.dwellMinutes,
                           where: whereFrom(leg.anchor, to: spot.coordinate)),
                note: cleaned(spot.note),
            )
        }
        // Named by the ballot and gone from the leg. Better an empty
        // line than a confident one about a spot nobody can find.
        return Details(spot: nil, line: "", note: nil)
    }

    /// Which day and block a stop sits on, if any.
    private static func placed(
        _ osmRef: String,
        in leg: TripLeg,
    ) -> (stop: TripStop, dayLabel: String, blockLabel: String)? {
        for day in leg.days {
            for block in day.blocks {
                if let stop = block.stops.first(where: { $0.osmRef == osmRef }) {
                    return (stop, "Tag \(day.dayIndex + 1)", block.label)
                }
            }
        }
        return nil
    }

    private static func line(category: String, dwellMinutes: Int, where whereText: String) -> String {
        var parts = [TripCategory.label(category)]
        if dwellMinutes > 0 { parts.append(TripClock.duration(dwellMinutes)) }
        if !whereText.isEmpty { parts.append(whereText) }
        return parts.joined(separator: " · ")
    }

    private static func cleaned(_ note: String?) -> String? {
        let trimmed = note?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    /// "1,2 km nordwestlich" — where it is, for a spot no day holds yet.
    ///
    /// From the quarters, because that is the point every day starts
    /// and ends at (§4.2) and therefore the only distance a reader can
    /// convert into "before breakfast" or "that is an afternoon".
    /// Rounded to eight directions: a bearing of 23° is a precision
    /// nobody standing on a street can use.
    static func whereFrom(_ anchor: TripCoordinate, to spot: TripCoordinate) -> String {
        let metres = Int(metresBetween(anchor, spot).rounded())
        if metres < 150 { return "an der Unterkunft" }
        return "\(TripDistance.text(metres)) \(compass(from: anchor, to: spot))"
    }

    /// Great-circle distance in metres.
    static func metresBetween(_ a: TripCoordinate, _ b: TripCoordinate) -> Double {
        let earth = 6_371_000.0
        let toRad = { (deg: Double) in deg * .pi / 180 }
        let dLat = toRad(b.lat - a.lat)
        let dLon = toRad(b.lon - a.lon)
        let lat1 = toRad(a.lat)
        let lat2 = toRad(b.lat)
        let h = pow(sin(dLat / 2), 2) + cos(lat1) * cos(lat2) * pow(sin(dLon / 2), 2)
        return 2 * earth * asin(min(1, sqrt(h)))
    }

    private static let points = [
        "nördlich", "nordöstlich", "östlich", "südöstlich",
        "südlich", "südwestlich", "westlich", "nordwestlich",
    ]

    /// One of eight directions, as a word.
    static func compass(from a: TripCoordinate, to b: TripCoordinate) -> String {
        let toRad = { (deg: Double) in deg * .pi / 180 }
        let dLon = toRad(b.lon - a.lon)
        let lat1 = toRad(a.lat)
        let lat2 = toRad(b.lat)
        let y = sin(dLon) * cos(lat2)
        let x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dLon)
        let degrees = (atan2(y, x) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
        let index = Int((degrees / 45).rounded()) % points.count
        return points[index]
    }
}
