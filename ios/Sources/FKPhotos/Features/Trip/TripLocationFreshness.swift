import CoreLocation
import Foundation

/// When a last-known fix is still worth using instead of waiting for a
/// new one.
///
/// Split out from the provider so the rule can be read and tested
/// without CoreLocation in the loop. Two limits, both deliberately
/// modest:
///
///   - **A minute old.** A redistribution asks "where are we now"
///     (§5); a fix from ten minutes ago answers a different question,
///     and on foot a minute is a street corner.
///   - **A hundred metres.** The planner asks for ten-metre accuracy
///     because being a kilometre out rearranges the afternoon around
///     the wrong corner — but for choosing which block you are standing
///     in, a hundred metres is the same corner, and it beats making
///     somebody press the button twice.
enum TripLocationFreshness {
    static let maxAge: TimeInterval = 60
    static let maxAccuracyM: CLLocationDistance = 100

    static func isUsable(_ location: CLLocation, now: Date) -> Bool {
        // A negative accuracy means the fix is invalid, not that it is
        // perfect.
        guard location.horizontalAccuracy >= 0,
              location.horizontalAccuracy <= maxAccuracyM else { return false }
        let age = now.timeIntervalSince(location.timestamp)
        return age >= 0 && age <= maxAge
    }
}
