import CoreLocation
import Foundation

/// Did a photo confirm this stay? (§6.4, signal 2.)
///
/// The concept calls this the best evidence there is and notes that it
/// costs nothing, because the machinery already exists: Trip Mode
/// collects photos with place and time anyway. All that is needed is
/// the question — was one of them taken *here*, *then*.
///
/// Deliberately strict about both halves, because a wrong confirmation
/// is the expensive kind of error. One signal asks and two act
/// (§6.4), so a loose photo rule paired with a walk-past dwell would
/// tick off a museum nobody entered.
enum TripPhotoSignal {
    /// How far outside the fence a photo may still count.
    ///
    /// A little slack, and no more. A photo of the cathedral taken from
    /// the square is a fair confirmation; one taken from the hill on
    /// the other side of town is a photo *of* the place, not evidence
    /// of being *at* it.
    static let slackMetres: CLLocationDistance = 50

    /// How far outside the stay's window a photo may still count.
    ///
    /// The geofence fires on the boundary and the photo is taken
    /// inside, so the two are close already; this covers the ordinary
    /// disagreement between a camera's clock and a location fix, not a
    /// visit on a different afternoon.
    static let slackSeconds: TimeInterval = 5 * 60

    struct Photo: Equatable, Sendable {
        let takenAt: Date
        /// Nil for a photo with no location — which is common, and is
        /// not evidence either way.
        let coordinate: CLLocationCoordinate2D?

        static func == (lhs: Photo, rhs: Photo) -> Bool {
            lhs.takenAt == rhs.takenAt
                && lhs.coordinate?.latitude == rhs.coordinate?.latitude
                && lhs.coordinate?.longitude == rhs.coordinate?.longitude
        }
    }

    /// Was any of these photos taken at this place during this stay?
    static func confirms(
        _ stay: TripStay,
        region: TripMonitoredRegion,
        photos: [Photo],
    ) -> Bool {
        let from = stay.arrivedAt.addingTimeInterval(-slackSeconds)
        let until = stay.departedAt.addingTimeInterval(slackSeconds)
        let centre = CLLocation(latitude: region.center.latitude, longitude: region.center.longitude)

        return photos.contains { photo in
            guard let coordinate = photo.coordinate else { return false }
            guard photo.takenAt >= from, photo.takenAt <= until else { return false }
            let spot = CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude)
            return spot.distance(from: centre) <= region.radius + slackMetres
        }
    }
}
