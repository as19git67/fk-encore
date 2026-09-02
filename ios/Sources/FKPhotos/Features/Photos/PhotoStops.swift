import Foundation

/// Grouping photos with coordinates into the places they were taken.
///
/// A port of the web's `usePhotoStops` (`frontend/src/composables/usePhotoStops.ts`),
/// which drives `TripMap.vue`. Both clients must draw the same pins for the
/// same album, so the rules live here as pure functions with the web's
/// constants, not as something the map view improvises.
///
/// The shape of it: photos are grouped by the **local** day they were taken,
/// each day is clustered into stops, and the stops of all days together form
/// the trip. Overview clusters merge stops across days into one pin per
/// region, for a map zoomed out over the whole trip.
enum PhotoStops {

    // MARK: - Constants

    /// Photos within this distance of a cluster centroid join that cluster.
    static let clusterIncludeMeters: Double = 400
    /// Two finished day-clusters whose centroids are closer than this get merged.
    static let minClusterSeparationMeters: Double = 600
    /// In overview mode, stops whose centroids are closer than this get merged.
    static let overviewMergeMeters: Double = 8000

    /// A day whose photos span at least this distance uses the full radii above.
    /// Days packed into a smaller area — a whole day spent in one city — scale
    /// them down proportionally, so the day still breaks into several stops
    /// instead of collapsing into a single pin.
    static let radiusReferenceSpanMeters: Double = 20000
    /// Lower bound for that scale, so a burst of photos taken at one spot does
    /// not shatter into dozens of single-photo stops.
    static let minRadiusScale: Double = 0.25

    /// Floor for the zoom-driven radius. GPS jitter is 5–10 m, so without this
    /// a burst taken at one spot shatters into single-photo stops once the map
    /// is zoomed all the way in.
    static let minZoomClusterRadiusMeters: Double = 25

    /// Two pins closer than this on screen overlap, which is what the
    /// zoom-driven radius is derived from.
    static let pinOverlapPoints: Double = 60

    // MARK: - Types

    struct Coordinate: Equatable, Sendable {
        let latitude: Double
        let longitude: Double
    }

    /// One place, on one day.
    struct Stop: Identifiable, Sendable {
        let id: Int
        let coordinate: Coordinate
        /// The stop's photos, earliest first.
        let photos: [PhotoWithCuration]
        /// The photo to show on the pin — the highest-scoring one.
        let coverPhoto: PhotoWithCuration
        /// Local day key, `YYYY-MM-DD`.
        let day: String
        let locationLabel: String
    }

    /// Several stops merged into one pin, for a map over the whole trip.
    struct OverviewCluster: Identifiable, Sendable {
        let id: Int
        let coordinate: Coordinate
        let stopIds: [Int]
        let photos: [PhotoWithCuration]
        let coverPhoto: PhotoWithCuration
    }

    /// A line drawn between two consecutive stops.
    struct Jump: Sendable {
        let fromDay: String
        let toDay: String
        let from: Coordinate
        let to: Coordinate
    }

    /// A map region to fit, already padded.
    struct Bounds: Equatable, Sendable {
        let minLatitude: Double
        let minLongitude: Double
        let maxLatitude: Double
        let maxLongitude: Double
    }

    // MARK: - Distance

    /// Great-circle distance in meters.
    static func distance(_ a: Coordinate, _ b: Coordinate) -> Double {
        let earthRadius: Double = 6_371_000
        let dLat = (b.latitude - a.latitude) * .pi / 180
        let dLon = (b.longitude - a.longitude) * .pi / 180
        let lat1 = a.latitude * .pi / 180
        let lat2 = b.latitude * .pi / 180
        let h = sin(dLat / 2) * sin(dLat / 2)
            + cos(lat1) * cos(lat2) * sin(dLon / 2) * sin(dLon / 2)
        return earthRadius * 2 * atan2(sqrt(h), sqrt(1 - h))
    }

    // MARK: - Photo helpers

    /// The photo's coordinate, or nil when it carries no GPS.
    static func coordinate(of photo: PhotoWithCuration) -> Coordinate? {
        guard let lat = photo.latitude, let lon = photo.longitude else { return nil }
        return Coordinate(latitude: lat, longitude: lon)
    }

    /// When the photo was taken, falling back to when it was created.
    ///
    /// Parsed with `PhotoFilter.parseDate`, which already covers every shape
    /// the API returns (ISO 8601 with or without fractional seconds, and the
    /// raw PostgreSQL format the string-mode Drizzle columns send). An
    /// unparseable pair puts the photo at the epoch rather than dropping it,
    /// so no photo silently disappears from a stop.
    static func takenAt(_ photo: PhotoWithCuration) -> Date {
        if let taken = photo.taken_at, let date = PhotoFilter.parseDate(taken) { return date }
        if let date = PhotoFilter.parseDate(photo.created_at) { return date }
        return Date(timeIntervalSince1970: 0)
    }

    /// The **local** day a photo belongs to, `YYYY-MM-DD`.
    ///
    /// Deliberately local, matching the web: a UTC key would move an evening
    /// photo east of UTC onto the next day and split one evening across two
    /// map days.
    static func dayKey(_ photo: PhotoWithCuration, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: takenAt(photo))
        return String(
            format: "%04d-%02d-%02d",
            parts.year ?? 0, parts.month ?? 0, parts.day ?? 0
        )
    }

    /// The photo to represent a group: the best-scoring one, first on a tie.
    static func cover(of photos: [PhotoWithCuration]) -> PhotoWithCuration? {
        photos.reduce(nil) { best, photo in
            guard let best else { return photo }
            return (photo.ai_quality_score ?? 0) > (best.ai_quality_score ?? 0) ? photo : best
        }
    }

    /// The stop's caption, mirroring the web's `formatLocationLabel`: place
    /// then city, country only when nothing else is known, and duplicate
    /// comma-separated tokens dropped — a reverse-geocoded `location_name`
    /// usually already carries the city, which would otherwise read
    /// „Beispielgasse 4, Musterstadt, Musterstadt".
    static func locationLabel(for photo: PhotoWithCuration) -> String {
        var parts: [String] = []
        if let name = photo.location_name, !name.isEmpty { parts.append(name) }
        if let city = photo.location_city, !city.isEmpty { parts.append(city) }
        if parts.isEmpty, let country = photo.location_country, !country.isEmpty {
            parts.append(country)
        }

        var seen = Set<String>()
        var out: [String] = []
        for part in parts {
            for raw in part.components(separatedBy: ",") {
                let token = raw.trimmingCharacters(in: .whitespaces)
                guard !token.isEmpty else { continue }
                let key = token.lowercased()
                guard !seen.contains(key) else { continue }
                seen.insert(key)
                out.append(token)
            }
        }
        return out.joined(separator: ", ")
    }

    // MARK: - Radii

    /// Diagonal extent of the box around a set of coordinates.
    static func span(of coordinates: [Coordinate]) -> Double {
        guard let first = coordinates.first else { return 0 }
        var minLat = first.latitude, maxLat = first.latitude
        var minLon = first.longitude, maxLon = first.longitude
        for c in coordinates.dropFirst() {
            minLat = min(minLat, c.latitude); maxLat = max(maxLat, c.latitude)
            minLon = min(minLon, c.longitude); maxLon = max(maxLon, c.longitude)
        }
        return distance(
            Coordinate(latitude: minLat, longitude: minLon),
            Coordinate(latitude: maxLat, longitude: maxLon)
        )
    }

    /// The radii to cluster one day with, tightened for a day spent in a small
    /// area so it still splits into several stops.
    static func radii(forDaySpan spanMeters: Double) -> (include: Double, separation: Double) {
        let scale = min(1, max(minRadiusScale, spanMeters / radiusReferenceSpanMeters))
        return (clusterIncludeMeters * scale, minClusterSeparationMeters * scale)
    }

    /// The radii for a caller-supplied radius — the map's "pins closer than
    /// this overlap" threshold, projected to meters at the current zoom.
    ///
    /// This is what keeps pins and timeline cards 1:1 at every zoom level:
    /// zooming in splits stops, zooming out merges them, and both views read
    /// the same clustering pass. The include/separation ratio mirrors the
    /// static defaults (400/600).
    static func radii(forZoomRadius radiusMeters: Double) -> (include: Double, separation: Double) {
        let separation = max(minZoomClusterRadiusMeters, radiusMeters)
        return (separation * (clusterIncludeMeters / minClusterSeparationMeters), separation)
    }

    /// How many meters one screen point covers, from the span the map is
    /// showing and how wide it is drawn.
    ///
    /// A degree of longitude shrinks with the cosine of the latitude, which is
    /// the same correction the web makes via the Web Mercator
    /// `156543.03 · cos(lat) / 2^zoom`; deriving it from the visible region
    /// avoids needing a "zoom level" MapKit does not hand out.
    static func metersPerPoint(
        longitudeDelta: Double,
        latitude: Double,
        widthInPoints: Double
    ) -> Double? {
        guard widthInPoints > 0, longitudeDelta > 0 else { return nil }
        let metersPerDegree = 111_320 * cos(latitude * .pi / 180)
        guard metersPerDegree > 0 else { return nil }
        return longitudeDelta * metersPerDegree / widthInPoints
    }

    /// The cluster radius for what the map is currently showing: the distance
    /// at which two pins would start to overlap.
    static func clusterRadius(
        longitudeDelta: Double,
        latitude: Double,
        widthInPoints: Double
    ) -> Double? {
        metersPerPoint(
            longitudeDelta: longitudeDelta,
            latitude: latitude,
            widthInPoints: widthInPoints
        ).map { $0 * pinOverlapPoints }
    }

    // MARK: - Clustering

    private struct Centroid {
        var latitude: Double
        var longitude: Double
        var photos: [PhotoWithCuration]

        var coordinate: Coordinate {
            Coordinate(latitude: latitude, longitude: longitude)
        }
    }

    /// Cluster one day's photos.
    ///
    /// Two passes, as on the web. First greedy and chronological: each photo
    /// joins its nearest cluster when that is within `include`, otherwise it
    /// seeds a new one. Then repeatedly merge the closest pair of clusters
    /// while they sit closer than `separation`, which is what actually
    /// guarantees the minimum distance between finished stops — the greedy
    /// pass alone can leave two centroids that drifted together. Every photo
    /// ends up in exactly one cluster.
    private static func clusterDay(
        _ photos: [(photo: PhotoWithCuration, coordinate: Coordinate)],
        include: Double,
        separation: Double
    ) -> [Centroid] {
        guard !photos.isEmpty else { return [] }
        let sorted = photos.sorted { takenAt($0.photo) < takenAt($1.photo) }

        var clusters: [Centroid] = []
        for entry in sorted {
            var bestIndex = -1
            var bestDistance = Double.infinity
            for (index, cluster) in clusters.enumerated() {
                let d = distance(cluster.coordinate, entry.coordinate)
                if d < bestDistance {
                    bestDistance = d
                    bestIndex = index
                }
            }
            if bestIndex >= 0 && bestDistance <= include {
                // Running mean, so the centroid stays the average of its photos.
                let n = Double(clusters[bestIndex].photos.count + 1)
                clusters[bestIndex].latitude += (entry.coordinate.latitude - clusters[bestIndex].latitude) / n
                clusters[bestIndex].longitude += (entry.coordinate.longitude - clusters[bestIndex].longitude) / n
                clusters[bestIndex].photos.append(entry.photo)
            } else {
                clusters.append(Centroid(
                    latitude: entry.coordinate.latitude,
                    longitude: entry.coordinate.longitude,
                    photos: [entry.photo]
                ))
            }
        }

        mergeClosestPairs(&clusters, closerThan: separation)
        return clusters
    }

    /// Repeatedly merge the closest pair of centroids while they are closer
    /// than `threshold`, weighting the merged centroid by photo count.
    private static func mergeClosestPairs(_ clusters: inout [Centroid], closerThan threshold: Double) {
        while clusters.count > 1 {
            var bestI = -1, bestJ = -1
            var bestDistance = Double.infinity
            for i in clusters.indices {
                for j in (i + 1)..<clusters.count {
                    let d = distance(clusters[i].coordinate, clusters[j].coordinate)
                    if d < bestDistance {
                        bestDistance = d
                        bestI = i
                        bestJ = j
                    }
                }
            }
            guard bestDistance < threshold, bestI >= 0 else { return }
            let a = clusters[bestI], b = clusters[bestJ]
            let na = Double(a.photos.count), nb = Double(b.photos.count)
            clusters[bestI] = Centroid(
                latitude: (a.latitude * na + b.latitude * nb) / (na + nb),
                longitude: (a.longitude * na + b.longitude * nb) / (na + nb),
                photos: a.photos + b.photos
            )
            clusters.remove(at: bestJ)
        }
    }

    // MARK: - Stops

    /// Every stop across every day, days in order and stops within a day in
    /// chronological order, so walking the list traces the trip.
    ///
    /// Photos without coordinates are not on a map and are dropped.
    ///
    /// - Parameter clusterRadiusMeters: when given, drives the clustering
    ///   instead of the day-span heuristic — the map passes what its current
    ///   zoom makes two pins overlap at, so pins and timeline cards stay 1:1.
    ///   Nil before the map has a view, and in any caller that just wants the
    ///   stops.
    ///
    /// - Important: stop ids are positions in *this* result. A different
    ///   radius produces a different set, so nothing may hold on to an id
    ///   across a re-cluster — anchor on a photo id and re-resolve with
    ///   `stop(containing:in:)`.
    static func stops(
        for photos: [PhotoWithCuration],
        clusterRadiusMeters: Double? = nil,
        calendar: Calendar = .current
    ) -> [Stop] {
        var byDay: [String: [(photo: PhotoWithCuration, coordinate: Coordinate)]] = [:]
        for photo in photos {
            guard let coordinate = coordinate(of: photo) else { continue }
            byDay[dayKey(photo, calendar: calendar), default: []].append((photo, coordinate))
        }
        guard !byDay.isEmpty else { return [] }

        var result: [Stop] = []
        var nextId = 0
        for day in byDay.keys.sorted() {
            let entries = byDay[day]!
            let (include, separation) = clusterRadiusMeters.map(radii(forZoomRadius:))
                ?? radii(forDaySpan: span(of: entries.map(\.coordinate)))
            var clusters = clusterDay(entries, include: include, separation: separation)
            // Within a day, order stops by their earliest photo so the path
            // between them follows the movement rather than the merge order.
            clusters.sort { a, b in
                let ta = a.photos.map(takenAt).min() ?? .distantPast
                let tb = b.photos.map(takenAt).min() ?? .distantPast
                return ta < tb
            }
            for cluster in clusters {
                let photosByTime = cluster.photos.sorted { takenAt($0) < takenAt($1) }
                guard let cover = cover(of: cluster.photos) else { continue }
                result.append(Stop(
                    id: nextId,
                    coordinate: cluster.coordinate,
                    photos: photosByTime,
                    coverPhoto: cover,
                    day: day,
                    locationLabel: locationLabel(for: cover)
                ))
                nextId += 1
            }
        }
        return result
    }

    /// The days that have stops, in order.
    static func days(of stops: [Stop]) -> [String] {
        Array(Set(stops.map(\.day))).sorted()
    }

    /// Stops grouped by their day.
    static func byDay(_ stops: [Stop]) -> [String: [Stop]] {
        Dictionary(grouping: stops, by: \.day)
    }

    /// The stop a photo ended up in.
    ///
    /// A re-cluster renumbers every stop, so a selection cannot be an id — it
    /// is a photo, and this finds where that photo lives now. The web does the
    /// same with its `selectedAnchorPhotoId`.
    static func stop(containing photoId: Int, in stops: [Stop]) -> Stop? {
        stops.first { $0.photos.contains { $0.id == photoId } }
    }

    // MARK: - Timeline

    /// The palette the web assigns to days, in order, wrapping when a trip
    /// outlasts it. Kept identical so a trip is coloured the same on both.
    static let dayColors: [String] = [
        "#4285F4", "#EA4335", "#34A853", "#FBBC05", "#9C27B0",
        "#FF6D00", "#00ACC1", "#C62828", "#2E7D32", "#F06292",
    ]

    /// A `#RRGGBB` string as channel values in 0…1, or nil when it is not one.
    /// The palette is kept as hex so it can be compared to the web's literally;
    /// this is what turns it into something SwiftUI can draw.
    static func rgb(fromHex hex: String) -> (red: Double, green: Double, blue: Double)? {
        var digits = hex.trimmingCharacters(in: .whitespaces)
        if digits.hasPrefix("#") { digits.removeFirst() }
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return nil }
        return (
            Double((value >> 16) & 0xFF) / 255,
            Double((value >> 8) & 0xFF) / 255,
            Double(value & 0xFF) / 255
        )
    }

    /// Each day's colour, by its position in the trip.
    static func colors(forDays days: [String]) -> [String: String] {
        var map: [String: String] = [:]
        for (index, day) in days.enumerated() {
            map[day] = dayColors[index % dayColors.count]
        }
        return map
    }

    /// A stop's caption, falling back to its number when nothing reverse-
    /// geocoded. `id` is zero-based, so the reader sees „Stopp 1" first.
    static func title(of stop: Stop) -> String {
        stop.locationLabel.isEmpty ? "Stopp \(stop.id + 1)" : stop.locationLabel
    }

    /// One card in the timeline strip.
    ///
    /// The web shows every stop across every day as one continuous
    /// chronological run, led by an overview card, with same-day stops sharing
    /// a colour and the first of each day marked so the boundaries stay
    /// readable. This produces exactly that list.
    /// The overview card's id. Stop ids count up from zero, so a negative one
    /// can never collide with them.
    static let overviewEntryId = -1

    enum TimelineEntry: Identifiable, Sendable {
        case overview(dayCount: Int)
        case stop(Stop, isFirstOfDay: Bool, color: String)

        /// Distinct across the two cases: the overview card has its own
        /// reserved id, stops carry theirs.
        var id: Int {
            switch self {
            case .overview: return PhotoStops.overviewEntryId
            case .stop(let stop, _, _): return stop.id
            }
        }
    }

    static func timeline(for stops: [Stop]) -> [TimelineEntry] {
        guard !stops.isEmpty else { return [] }
        let orderedDays = days(of: stops)
        let colorForDay = colors(forDays: orderedDays)

        var entries: [TimelineEntry] = [.overview(dayCount: orderedDays.count)]
        var previousDay: String?
        // `stops` is already day-ordered and chronological within a day, so
        // walking it in order is the run the web draws.
        for stop in stops {
            entries.append(.stop(
                stop,
                isFirstOfDay: stop.day != previousDay,
                color: colorForDay[stop.day] ?? dayColors[0]
            ))
            previousDay = stop.day
        }
        return entries
    }

    // MARK: - Overview

    /// One pin per visited region: stops across all days merged while their
    /// centroids sit closer than `overviewMergeMeters`. Every stop lands in
    /// exactly one cluster.
    static func overviewClusters(for stops: [Stop]) -> [OverviewCluster] {
        guard !stops.isEmpty else { return [] }

        struct Working {
            var latitude: Double
            var longitude: Double
            var stopIds: [Int]
            var photos: [PhotoWithCuration]

            var coordinate: Coordinate {
                Coordinate(latitude: latitude, longitude: longitude)
            }
        }

        var clusters = stops.map {
            Working(
                latitude: $0.coordinate.latitude,
                longitude: $0.coordinate.longitude,
                stopIds: [$0.id],
                photos: $0.photos
            )
        }

        while clusters.count > 1 {
            var bestI = -1, bestJ = -1
            var bestDistance = Double.infinity
            for i in clusters.indices {
                for j in (i + 1)..<clusters.count {
                    let d = distance(clusters[i].coordinate, clusters[j].coordinate)
                    if d < bestDistance {
                        bestDistance = d
                        bestI = i
                        bestJ = j
                    }
                }
            }
            guard bestDistance < overviewMergeMeters, bestI >= 0 else { break }
            let a = clusters[bestI], b = clusters[bestJ]
            let na = Double(a.photos.count), nb = Double(b.photos.count)
            clusters[bestI] = Working(
                latitude: (a.latitude * na + b.latitude * nb) / (na + nb),
                longitude: (a.longitude * na + b.longitude * nb) / (na + nb),
                stopIds: a.stopIds + b.stopIds,
                photos: a.photos + b.photos
            )
            clusters.remove(at: bestJ)
        }

        return clusters.enumerated().compactMap { index, cluster in
            guard let cover = cover(of: cluster.photos) else { return nil }
            return OverviewCluster(
                id: index,
                coordinate: cluster.coordinate,
                stopIds: cluster.stopIds,
                photos: cluster.photos,
                coverPhoto: cover
            )
        }
    }

    // MARK: - Jumps

    /// The trip's biggest hops — the longest ~10 % of the moves between
    /// consecutive stops.
    ///
    /// Only consecutive pairs count: for A → B → C the candidates are A→B and
    /// B→C, never A→C. Drawing every hop would bury the map in lines between
    /// neighbouring stops, so only those at or above the 90th percentile are
    /// kept.
    static func longJumps(for stops: [Stop]) -> [Jump] {
        guard stops.count > 1 else { return [] }
        let candidates = zip(stops, stops.dropFirst()).map { a, b in
            Jump(fromDay: a.day, toDay: b.day, from: a.coordinate, to: b.coordinate)
        }
        let sorted = candidates.map { distance($0.from, $0.to) }.sorted()
        let index = Int((Double(sorted.count) * 0.9).rounded(.down))
        guard index < sorted.count else { return [] }
        let threshold = sorted[index]
        return candidates.filter { distance($0.from, $0.to) >= threshold }
    }

    // MARK: - Bounds

    /// The region covering these coordinates, padded by 10 % — with a floor,
    /// so a single pin still gets a region a map can show rather than a point.
    static func bounds(for coordinates: [Coordinate]) -> Bounds? {
        guard let first = coordinates.first else { return nil }
        var minLat = first.latitude, maxLat = first.latitude
        var minLon = first.longitude, maxLon = first.longitude
        for c in coordinates.dropFirst() {
            minLat = min(minLat, c.latitude); maxLat = max(maxLat, c.latitude)
            minLon = min(minLon, c.longitude); maxLon = max(maxLon, c.longitude)
        }
        let latPad = max((maxLat - minLat) * 0.1, 0.005)
        let lonPad = max((maxLon - minLon) * 0.1, 0.005)
        return Bounds(
            minLatitude: minLat - latPad,
            minLongitude: minLon - lonPad,
            maxLatitude: maxLat + latPad,
            maxLongitude: maxLon + lonPad
        )
    }

    static func bounds(for stops: [Stop]) -> Bounds? {
        bounds(for: stops.map(\.coordinate))
    }
}
