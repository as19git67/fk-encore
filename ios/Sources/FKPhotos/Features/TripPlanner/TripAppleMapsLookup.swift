import CoreLocation
import MapKit

/// Opening a stop in Apple Maps as the *place* rather than as a dot on
/// the map (§9.1, §10).
///
/// Handing Maps a bare coordinate opens a pin with a coordinate under
/// it: no opening hours, no photos, no reviews, no "Website". Those are
/// exactly the things open data cannot give the planner and the reason
/// the handoff exists at all — so a handoff that loses them is a
/// handoff that did not work.
///
/// Maps knows the place; it just has to be asked by name. So before
/// opening, the stop's name is searched for in a small region around
/// the coordinate the planner has, and a hit that is plausibly the same
/// place is opened instead of the raw pin.
///
/// **Plausibly** is the whole design. A search for "Frauenkirche" can
/// answer with a Frauenkirche in another city, a shop of that name, or
/// nothing at all, and opening the wrong place is worse than opening a
/// bare pin — the traveller walks somewhere else. Two independent
/// conditions therefore have to hold, and the matching is pure so both
/// can be tested without a network or a device:
///
///   - the hit sits within `maxDistanceM` of the planner's coordinate,
///   - and its name really is the stop's name, not merely a search
///     engine's best effort.
///
/// Everything else falls back to the coordinate, which is what the app
/// did before and is never wrong, only poorer.
enum TripAppleMapsLookup {

    /// How far a hit may sit from the planner's coordinate.
    ///
    /// 300 m is generous for a POI — Apple's entrance and OSM's centroid
    /// disagree by tens of metres on a large building — and far too
    /// tight for the same name in the next district, which is the
    /// mistake that matters.
    static let maxDistanceM: CLLocationDistance = 300

    /// A candidate from Maps, reduced to what the decision needs.
    struct Candidate: Equatable, Sendable {
        let name: String
        let coordinate: TripCoordinate
    }

    /// Which candidate is the stop, if any.
    ///
    /// Returns the closest one that passes both tests. Nil means "open
    /// the coordinate" — never "give up".
    static func pick(
        _ candidates: [Candidate],
        named name: String,
        near expected: TripCoordinate,
    ) -> Candidate? {
        let wanted = fold(name)
        guard !wanted.isEmpty else { return nil }
        return candidates
            .filter { namesAgree(fold($0.name), wanted) }
            .map { ($0, distance(from: $0.coordinate, to: expected)) }
            .filter { $0.1 <= maxDistanceM }
            .min { $0.1 < $1.1 }?
            .0
    }

    /// Are these two folded names the same place?
    ///
    /// Containment rather than equality, because the two sources name
    /// things differently in ways that are not disagreements: OSM's
    /// "Frauenkirche" is Apple's "Frauenkirche München", and OSM's
    /// "Museum Brandhorst" is Apple's "Museum Brandhorst". A bare
    /// containment test on very short names would match far too much,
    /// so anything under four characters has to match exactly.
    static func namesAgree(_ a: String, _ b: String) -> Bool {
        if a == b { return true }
        if a.count < 4 || b.count < 4 { return false }
        return a.contains(b) || b.contains(a)
    }

    /// Lowercased, without diacritics or punctuation, single-spaced.
    /// "Café-Bar Beispiel!" and "Cafe Bar Beispiel" are the same name.
    static func fold(_ name: String) -> String {
        let folded = name.folding(options: [.diacriticInsensitive, .caseInsensitive],
                                  locale: Locale(identifier: "en_US_POSIX"))
        let cleaned = folded.map { $0.isLetter || $0.isNumber ? $0 : " " }
        return String(cleaned).split(separator: " ").joined(separator: " ")
    }

    static func distance(from: TripCoordinate, to: TripCoordinate) -> CLLocationDistance {
        CLLocation(latitude: from.lat, longitude: from.lon)
            .distance(from: CLLocation(latitude: to.lat, longitude: to.lon))
    }

    /// Ask Maps for the place, and answer with its own map item.
    ///
    /// The impure half, deliberately three lines long. A failure of any
    /// kind — no network, no hit, a hit somewhere else — answers nil,
    /// and the caller opens the coordinate.
    @MainActor
    static func mapItem(named name: String, near place: TripCoordinate) async -> MKMapItem? {
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = name
        request.region = MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: place.lat, longitude: place.lon),
            // Twice the acceptance radius, so a hit just outside it is
            // still seen and then rejected on distance rather than
            // never returned at all.
            latitudinalMeters: maxDistanceM * 4,
            longitudinalMeters: maxDistanceM * 4,
        )
        guard let response = try? await MKLocalSearch(request: request).start() else { return nil }
        let items = response.mapItems.filter { $0.name?.isEmpty == false }
        let candidates = items.map {
            Candidate(name: $0.name ?? "",
                      coordinate: TripCoordinate(lat: $0.placemark.coordinate.latitude,
                                                 lon: $0.placemark.coordinate.longitude))
        }
        guard let picked = pick(candidates, named: name, near: place),
              let index = candidates.firstIndex(of: picked)
        else { return nil }
        return items[index]
    }
}
