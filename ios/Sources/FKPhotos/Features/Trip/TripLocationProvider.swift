import CoreLocation
import Foundation

/// One-shot location + reverse-geocoding helper for the trip start flow
/// (Etappe 1b-ii). Requests "when in use" authorization, fetches a single
/// coarse location and reverse-geocodes it to a place name used as the
/// trip-name suggestion. Also yields the coordinate for the trip geofence.
///
/// Deliberately forgiving: every failure path (denied permission, no fix,
/// geocoding error, timeout) resolves to `nil` so the start flow simply falls
/// back to a date-based name and a nil geofence — it can never hang or throw.
@MainActor
final class TripLocationProvider: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<CLLocation?, Never>?
    private var didResume = false

    /// - Parameter accuracy: kilometre-coarse by default, which is plenty for
    ///   a place name and a ~25 km geofence centre and returns a fix faster
    ///   and cheaper. The trip planner asks for `kCLLocationAccuracyNearestTenMeters`
    ///   instead: it feeds the position into a redistribution, where being a
    ///   kilometre out would rearrange the afternoon around the wrong corner.
    init(accuracy: CLLocationAccuracy = kCLLocationAccuracyKilometer) {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = accuracy
    }

    /// Returns the device's current location, or nil if permission is denied /
    /// no fix arrives within `timeout` seconds. Never throws.
    func currentLocation(timeout: TimeInterval = 8) async -> CLLocation? {
        let status = manager.authorizationStatus
        if status == .denied || status == .restricted { return nil }

        return await withCheckedContinuation { (cont: CheckedContinuation<CLLocation?, Never>) in
            self.continuation = cont
            self.didResume = false

            // Safety timeout so a missing fix can never hang the start flow.
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                self.resume(nil)
            }

            if status == .notDetermined {
                // The fix is requested from didChangeAuthorization once granted.
                manager.requestWhenInUseAuthorization()
            } else {
                manager.requestLocation()
            }
        }
    }

    /// Reverse-geocodes a location to a concise place name (locality, else
    /// admin area, else country). Returns nil when nothing usable is found.
    func placeName(for location: CLLocation) async -> String? {
        let placemarks = try? await CLGeocoder().reverseGeocodeLocation(location)
        guard let placemark = placemarks?.first else { return nil }
        return placemark.locality
            ?? placemark.subAdministrativeArea
            ?? placemark.administrativeArea
            ?? placemark.country
    }

    private func resume(_ location: CLLocation?) {
        guard !didResume else { return }
        didResume = true
        let cont = continuation
        continuation = nil
        cont?.resume(returning: location)
    }

    // MARK: - CLLocationManagerDelegate
    //
    // Callbacks arrive on the main thread (the manager was created on the main
    // actor). They are `nonisolated` to satisfy the protocol and hop back onto
    // the main actor to touch `manager` / `resume`.

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            switch self.manager.authorizationStatus {
            case .authorizedWhenInUse, .authorizedAlways:
                self.manager.requestLocation()
            case .denied, .restricted:
                self.resume(nil)
            default:
                break  // .notDetermined — wait for the user's choice
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let location = locations.last
        Task { @MainActor in self.resume(location) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in self.resume(nil) }
    }
}
