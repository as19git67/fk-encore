import Foundation

/// What is being handed over: one stop, or a whole block at once.
enum TripMapsChoice: Identifiable {
    case single(TripCoordinate, mode: TripTransportMode)
    case block([TripCoordinate], mode: TripTransportMode)

    var id: String {
        coordinates.map(TripMapsURL.coordinate).joined(separator: "|")
    }

    var coordinates: [TripCoordinate] {
        switch self {
        case let .single(c, _):  return [c]
        case let .block(cs, _):  return cs
        }
    }

    var routeMode: TripRouteMode {
        switch self {
        case let .single(_, mode), let .block(_, mode): return TripRouteMode(mode)
        }
    }
}

/// A stop on its way to another block, with where it stands now.
struct TripStopMove: Identifiable {
    let stop: TripStop
    let blockId: String
    var id: String { stop.osmRef }
}
