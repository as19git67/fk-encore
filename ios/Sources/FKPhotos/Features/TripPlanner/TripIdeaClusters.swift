import CoreLocation
import Foundation

/// The collection, sorted into places rather than into a list (§20.1).
///
/// A flat list of ideas is fine at five entries and useless at forty:
/// the beer garden two streets away and the museum in another country
/// sit next to each other, ordered by when somebody happened to save
/// them, and the one question the collection exists to answer — *what
/// have we got around here?* — has to be answered by reading all of it.
///
/// So entries that belong to the same place are grouped. „The same
/// place" is deliberately generous: a day-trip radius rather than a
/// city boundary, because what makes two entries belong together is
/// that one afternoon could hold both, not that they share a postcode.
///
/// **Single-link and not a k-means.** Two entries are in one group when
/// something links them within the radius, so a valley of villages
/// stays one group instead of being cut where a centroid happened to
/// fall. It means a long chain can grow wider than the radius, which is
/// the honest answer for a coastline: the alternative is a border drawn
/// where nobody would draw one on the ground.
///
/// Naming a group is not this module's job. Nothing here knows what a
/// region is called, and inventing a name from the entries would give
/// „Bank am Hang" to a group of nine. The screen asks Apple's geocoder,
/// which is the same division of labour as everywhere else: Apple
/// names, fk-encore plans (§9.1).
enum TripIdeaClusters {
    /// How far apart two entries may be and still be "here".
    ///
    /// Half an hour in the car, the same figure the outing proposal
    /// uses for what counts as reachable for an afternoon (§20.2): the
    /// grouping and the proposal should not disagree about what is one
    /// day out.
    static let radiusM: Double = 25_000

    /// Group the entries by where they are, keeping the list's order.
    ///
    /// The collection arrives newest first, and stays that way at the
    /// group level: a group is placed where its newest entry stood.
    /// Sorting groups by size instead would reshuffle the screen every
    /// time somebody saved something.
    static func group(
        _ ideas: [TripIdea],
        radiusM: Double = TripIdeaClusters.radiusM,
    ) -> [TripIdeaCluster] {
        guard !ideas.isEmpty else { return [] }

        // Union-find over "close enough to something in the group".
        var parent = Array(ideas.indices)
        func root(_ i: Int) -> Int {
            var node = i
            while parent[node] != node { node = parent[node] }
            var walk = i
            while parent[walk] != walk {
                let next = parent[walk]
                parent[walk] = node
                walk = next
            }
            return node
        }
        func union(_ a: Int, _ b: Int) {
            let (ra, rb) = (root(a), root(b))
            if ra != rb { parent[max(ra, rb)] = min(ra, rb) }
        }

        let places = ideas.map { CLLocation(latitude: $0.lat, longitude: $0.lon) }
        for i in ideas.indices {
            for j in ideas.indices where j > i {
                if places[i].distance(from: places[j]) <= radiusM { union(i, j) }
            }
        }

        // Grouped, in the order the groups first appear in the list.
        var order: [Int] = []
        var members: [Int: [TripIdea]] = [:]
        for i in ideas.indices {
            let key = root(i)
            if members[key] == nil { order.append(key) }
            members[key, default: []].append(ideas[i])
        }

        return order.map { key in
            let group = members[key] ?? []
            return TripIdeaCluster(
                id: group.map(\.id).min() ?? key,
                ideas: group,
                centre: centre(of: group),
            )
        }
    }

    /// The middle of a group, for asking what the place is called.
    ///
    /// A plain mean of the coordinates. Good enough for a name — the
    /// question is "which town is this", not "where exactly" — and the
    /// wrap-around at the date line that would break it needs a group
    /// spanning the Pacific.
    static func centre(of ideas: [TripIdea]) -> TripCoordinate {
        guard !ideas.isEmpty else { return TripCoordinate(lat: 0, lon: 0) }
        let count = Double(ideas.count)
        return TripCoordinate(
            lat: ideas.reduce(0) { $0 + $1.lat } / count,
            lon: ideas.reduce(0) { $0 + $1.lon } / count,
        )
    }
}

/// One place's worth of collected ideas.
struct TripIdeaCluster: Identifiable, Sendable {
    /// The lowest entry id in the group — stable while the group is,
    /// so SwiftUI keeps its section rather than rebuilding it whenever
    /// something is added somewhere else.
    let id: Int
    let ideas: [TripIdea]
    let centre: TripCoordinate

    /// What to call the group before the geocoder has answered — or if
    /// it never does. A count is honest; a made-up place name is not.
    var fallbackTitle: String {
        ideas.count == 1 ? "Ein Ort" : "\(ideas.count) Orte"
    }
}
