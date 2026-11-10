import CoreLocation
import Foundation

// The way between two places (reise-planen-und-unterwegs.md, stage 6):
// what the server answers for the sheet "Weg" and the day map, and the
// pure rules both read — the polyline, the line under a way, what the
// arrival check means.

/// One way in one mode, as `POST /trip-planner/routing/way` answers.
struct TripWay: Codable, Sendable, Equatable, Identifiable {
    /// The mode asked for.
    let mode: String
    /// The mode it is done in: a transit hop that is walked says "foot".
    let by: String
    let minutes: Int
    let distanceM: Int
    /// Encoded polyline, precision 6; nil for an estimate.
    let shape: String?
    /// False when the router had no answer and this is the estimate.
    let routed: Bool
    /// With a check: minutes after midnight at the far end.
    var arriveMinutes: Int? = nil
    /// open | before_opening | after_closing | closed_day | after_ticket; nil when nothing is known.
    var fit: String? = nil

    var id: String { mode }
    var transportMode: TripTransportMode { TripTransportMode(raw: mode) }
    var doneBy: TripTransportMode { TripTransportMode(raw: by) }
}

struct TripWayTarget: Codable, Sendable, Equatable {
    let openingText: String?
    let ticketMinutes: Int?
}

struct TripWayResponse: Codable, Sendable, Equatable {
    let ways: [TripWay]
    var target: TripWayTarget? = nil
}

/// One segment of a day, `GET …/days/:dayIndex/ways`.
struct TripDayWay: Codable, Sendable, Equatable, Identifiable {
    let fromRef: String
    let toRef: String
    let from: TripCoordinate
    let to: TripCoordinate
    let mode: String
    let by: String
    let minutes: Int
    let distanceM: Int
    let shape: String?
    let routed: Bool
    /// A mode somebody picked for this segment, rather than the stay's.
    let chosen: Bool

    var id: String { "\(fromRef)>\(toRef)" }
    var doneBy: TripTransportMode { TripTransportMode(raw: by) }
}

struct TripDayWaysResponse: Codable, Sendable, Equatable {
    let ways: [TripDayWay]
}

/// What the sheet "Weg" is opened with.
struct TripWayRequest: Identifiable, Equatable {
    struct End: Equatable {
        let name: String
        let coordinate: TripCoordinate
        /// The traveller's own position, which the map app knows better.
        var isHere = false
    }

    var from: End
    var to: End
    /// The spot the way goes to, to check the arrival on its day.
    var check: (dayIndex: Int, osmRef: String, departMinutes: Int)?
    /// The segment of the day it is, so a picked mode can be kept for it.
    var segment: (fromRef: String, toRef: String)?
    /// The mode the day uses for it now.
    var currentMode: TripTransportMode

    var id: String {
        "\(from.coordinate.lat),\(from.coordinate.lon)>\(to.coordinate.lat),\(to.coordinate.lon)"
    }

    static func == (lhs: TripWayRequest, rhs: TripWayRequest) -> Bool {
        lhs.id == rhs.id && lhs.currentMode == rhs.currentMode
            && lhs.segment?.fromRef == rhs.segment?.fromRef && lhs.segment?.toRef == rhs.segment?.toRef
    }

    /// From and To swapped; a check and a segment no longer apply.
    func swapped() -> TripWayRequest {
        TripWayRequest(from: to, to: from, check: nil, segment: nil, currentMode: currentMode)
    }
}

enum TripWays {
    /// Where the day sets off from, as a segment's `fromRef`.
    static let dayStart = "start"
    /// The modes the sheet compares.
    static let modes: [TripTransportMode] = [.foot, .bike, .transit, .car]

    /// Decode Google's polyline with six places, as Valhalla writes it.
    static func decode(_ encoded: String, precision: Int = 6) -> [TripCoordinate] {
        let factor = pow(10.0, Double(precision))
        let bytes = Array(encoded.utf8)
        var index = 0
        var lat = 0
        var lon = 0
        var points: [TripCoordinate] = []

        func next() -> Int? {
            var result = 0
            var shift = 0
            while true {
                guard index < bytes.count else { return nil }
                let byte = Int(bytes[index]) - 63
                index += 1
                result |= (byte & 0x1f) << shift
                shift += 5
                if byte < 0x20 { break }
            }
            return (result & 1) != 0 ? ~(result >> 1) : result >> 1
        }

        while index < bytes.count {
            guard let dLat = next(), let dLon = next() else { break }
            lat += dLat
            lon += dLon
            points.append(TripCoordinate(lat: Double(lat) / factor, lon: Double(lon) / factor))
        }
        return points
    }

    /// The line to draw: along the streets, or straight where there is no shape.
    static func path(shape: String?, from: TripCoordinate, to: TripCoordinate) -> [TripCoordinate] {
        if let shape {
            let points = decode(shape)
            if points.count >= 2 { return points }
        }
        return [from, to]
    }

    /// The point halfway along a line, for its label.
    static func midpoint(of points: [TripCoordinate]) -> TripCoordinate? {
        guard let first = points.first else { return nil }
        guard points.count >= 2 else { return first }
        var lengths: [Double] = []
        for i in 1..<points.count { lengths.append(distance(points[i - 1], points[i])) }
        let half = lengths.reduce(0, +) / 2
        var walked = 0.0
        for (i, length) in lengths.enumerated() {
            if walked + length >= half, length > 0 {
                let t = (half - walked) / length
                let a = points[i]
                let b = points[i + 1]
                return TripCoordinate(lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t)
            }
            walked += length
        }
        return points[points.count / 2]
    }

    /// "700 m", "2,4 km".
    static func distance(_ metres: Int) -> String {
        if metres < 1000 { return "\(max(10, (metres + 5) / 10 * 10)) m" }
        let km = Double(metres) / 1000
        return km < 10
            ? String(format: "%.1f km", km).replacingOccurrences(of: ".", with: ",")
            : "\(Int(km.rounded())) km"
    }

    /// "9 min zu Fuß · 700 m"
    static func line(minutes: Int, distanceM: Int, by mode: TripTransportMode) -> String {
        "\(TripClock.duration(minutes)) \(mode.label) · \(distance(distanceM))"
    }

    /// The mode a stop is reached by, the way the list says it.
    static func mode(of stop: TripStop, leg: TripLeg) -> TripTransportMode {
        if let picked = stop.wayMode { return TripTransportMode(raw: picked) }
        // A transit day walks the short hops (travel.ts); the class says which.
        if leg.transportMode == .transit, stop.travelFromPrevious.travelClass.hasSuffix("walk") { return .foot }
        return leg.transportMode
    }

    /// What the arrival means, in one line; nil when nothing is known.
    static func fitText(_ way: TripWay, target: TripWayTarget?) -> String? {
        guard let arrive = way.arriveMinutes else { return nil }
        let at = "Ankunft ca. \(TripClock.format(arrive))"
        switch way.fit {
        case "open":
            return target?.openingText.map { "\(at) · geöffnet \($0)" } ?? "\(at) · geöffnet"
        case "before_opening":
            return target?.openingText.map { "\(at) · öffnet erst \($0)" } ?? "\(at) · noch geschlossen"
        case "after_closing":
            return target?.openingText.map { "\(at) · dann geschlossen (\($0))" } ?? "\(at) · dann geschlossen"
        case "closed_day":
            return "\(at) · an diesem Tag geschlossen"
        case "after_ticket":
            return target?.ticketMinutes.map { "\(at) · zu spät für \(TripClock.format($0))" } ?? "\(at) · zu spät"
        default:
            return at
        }
    }

    /// "Mit dem Auto" from "mit dem Auto", to start a sentence.
    static func capitalized(_ text: String) -> String {
        guard let first = text.first else { return text }
        return first.uppercased() + text.dropFirst()
    }

    /// The arrival needs a second look.
    static func isWarning(_ way: TripWay) -> Bool {
        ["after_closing", "closed_day", "after_ticket"].contains(way.fit ?? "")
    }

    /// The segments of a day in the order the day walks them: from the
    /// start of the day, then from spot to spot.
    static func segments(of stops: [TripStop]) -> [(fromRef: String, toRef: String)] {
        var from = dayStart
        return stops.map { stop in
            defer { from = stop.osmRef }
            return (from, stop.osmRef)
        }
    }

    private static func distance(_ a: TripCoordinate, _ b: TripCoordinate) -> Double {
        CLLocation(latitude: a.lat, longitude: a.lon).distance(from: CLLocation(latitude: b.lat, longitude: b.lon))
    }
}
