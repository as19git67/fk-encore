import Foundation

/// How far a day reaches, per mode (§4.2).
///
/// The screen sends an explicit radius with every leg, so the server's
/// own default never applies to a trip made in the app — which is how a
/// week in San Francisco came back as the four streets around the
/// hotel. Three kilometres is a walking radius around a European old
/// town: the bridge is six kilometres out, the park seven, Sausalito
/// ten. All of them were simply never searched.
///
/// Mirrors `trip-planner/search-reach.ts`. Kept as a plain enum with no
/// state and no actor, so both the draft and its tests can read it.
enum TripReach {
    /// What to search around the anchor for this mode.
    static func radius(for mode: TripTransportMode) -> Int {
        switch mode {
        case .foot:    return 3_000
        case .bike:    return 8_000
        case .transit: return 18_000
        case .car:     return 25_000
        }
    }

    /// The radius after somebody changed the mode.
    ///
    /// Only moves a radius that was still the old mode's default: a
    /// number somebody set by hand is an answer, and overwriting it
    /// because they then picked "mit dem Auto" would throw away the more
    /// specific of the two statements. That is also why the comparison
    /// is against the old mode's default rather than a "touched" flag —
    /// the flag would have to survive editing, reordering and the draft
    /// being rebuilt from a sentence.
    static func radius(
        movingFrom oldMode: TripTransportMode,
        to newMode: TripTransportMode,
        current: Int,
    ) -> Int {
        current == radius(for: oldMode) ? radius(for: newMode) : current
    }

    /// The bounds the screen offers. The upper one matches what the geo
    /// service will search at all.
    static let minRadiusM = 100
    static let maxRadiusM = 50_000
}
