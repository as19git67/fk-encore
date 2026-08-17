import CoreLocation
import Foundation
import Observation
import Photos
import UIKit
import UserNotifications

/// Suggests switching Trip Mode on when the recent photos show the user is far
/// from home and has been for a while (`docs/ios-trip-mode.md` §9.2). Never
/// starts a trip on its own — starting creates albums and changes what gets
/// uploaded, so it always ends at a sheet the user confirms.
///
/// Runs off the photo library rather than CoreLocation: no trip is active yet,
/// so there is nothing to justify continuous location monitoring or the
/// "Always" permission it needs. The enumeration this does is the same shape
/// the sync pass already performs, and `PHAsset.location` carries the
/// coordinates for free.
@Observable @MainActor
public final class TripAutoStartMonitor {
    public static let shared = TripAutoStartMonitor()

    /// The raised suggestion, mirrored in memory so SwiftUI can observe it —
    /// `TripView`'s banner and the tab-bar badge both react to this. The
    /// UserDefaults copy in `TripAutoStartPreferences` is what survives a
    /// relaunch (the notification action routinely runs in a fresh process);
    /// this property is loaded from it at init and written through on change.
    private(set) var pendingSuggestion: PendingStartSuggestion?

    /// True once the user picked "Trip starten" — `TripView` consumes this and
    /// opens the prefilled sheet.
    private(set) var shouldPresentStartSheet: Bool

    /// Public for the same reason as the auto-end category: `Main.swift` lives
    /// in the App target and has to tell the two categories apart before
    /// routing a notification response.
    public nonisolated static let notificationCategoryId = "trip.autostart"
    nonisolated static let startActionId = "trip.autostart.start"
    nonisolated static let dismissActionId = "trip.autostart.dismiss"
    nonisolated static let neverHereActionId = "trip.autostart.neverHere"

    /// Guards against two overlapping evaluations — the sync pass and the
    /// library observer routinely fire together.
    private var isEvaluating = false

    private init() {
        pendingSuggestion = TripAutoStartPreferences.pendingSuggestion
        shouldPresentStartSheet = TripAutoStartPreferences.shouldPresentStartSheet
    }

    // MARK: - Suggestion state

    private func store(_ suggestion: PendingStartSuggestion?) {
        pendingSuggestion = suggestion
        TripAutoStartPreferences.pendingSuggestion = suggestion
    }

    private func setPresentStartSheet(_ value: Bool) {
        shouldPresentStartSheet = value
        TripAutoStartPreferences.shouldPresentStartSheet = value
    }

    /// Clears the suggestion and starts the cooldown. The entry point for every
    /// "no" the user can give — the notification's "Nicht jetzt", the banner's
    /// dismiss, and a plain notification tap.
    func dismissSuggestion() {
        store(nil)
        setPresentStartSheet(false)
        TripAutoStartPreferences.lastSuggestionAt = Date()
    }

    /// Silences this region for good (§9.3) and clears the suggestion.
    func suppressCurrentRegion() {
        if let cell = pendingSuggestion?.regionCell {
            TripRegionSuppression.suppress(cell: cell)
        }
        dismissSuggestion()
    }

    /// Consumes the "open the start sheet" handoff, returning the name to
    /// prefill. Consuming clears the suggestion so reopening the tab doesn't
    /// present the sheet a second time.
    func consumeStartSheetRequest() -> String? {
        guard shouldPresentStartSheet else { return nil }
        let name = pendingSuggestion?.suggestedName
        setPresentStartSheet(false)
        store(nil)
        TripAutoStartPreferences.lastSuggestionAt = Date()
        return name ?? TripStore.defaultTripName()
    }

    static func notificationCategory() -> UNNotificationCategory {
        let start = UNNotificationAction(
            identifier: startActionId, title: "Trip starten", options: [.foreground]
        )
        let dismiss = UNNotificationAction(
            identifier: dismissActionId, title: "Nicht jetzt", options: []
        )
        let neverHere = UNNotificationAction(
            identifier: neverHereActionId, title: "Für diesen Ort nicht mehr fragen",
            options: [.destructive]
        )
        return UNNotificationCategory(
            identifier: notificationCategoryId,
            actions: [start, dismiss, neverHere],
            intentIdentifiers: [],
            options: []
        )
    }

    // MARK: - Evaluation

    /// Looks at the recent geotagged photos and raises a suggestion if they
    /// show a stay far from home. Cheap and idempotent: safe to call from every
    /// sync pass and every photo-library change.
    func evaluate() async {
        guard !isEvaluating else { return }
        guard TripSuggestionSettings.enabled else { return }
        // A trip is already running (or just ended and is still catching up) —
        // there is exactly one active trip (§14.4), so nothing to suggest.
        guard !TripStore.shared.hasPendingTripWork else { return }
        guard pendingSuggestion == nil else { return }
        guard !TripAutoStartHeuristic.isWithinCooldown(
            lastSuggestionAt: TripAutoStartPreferences.lastSuggestionAt, now: Date()
        ) else { return }

        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else { return }

        isEvaluating = true
        defer { isEvaluating = false }

        guard let home = await TripHomeLocation.resolve() else { return }

        let samples = await Self.recentGeotaggedSamples(
            since: Date().addingTimeInterval(-TripAutoStartPreferences.lookback)
        )
        recordVisits(from: samples)

        guard let outcome = TripAutoStartHeuristic.evaluate(
            samples: samples, home: home, now: Date()
        ) else { return }

        // Re-check the guards that could have changed while we were awaiting
        // the home location and the enumeration.
        guard !TripStore.shared.hasPendingTripWork, pendingSuggestion == nil else { return }

        // §9.3: a region the user silenced — or one they visit so often it is
        // plainly a second home — never produces a suggestion.
        guard !TripRegionSuppression.isSuppressed(cell: outcome.regionCell) else { return }

        await raiseSuggestion(for: outcome)
    }

    /// Feeds §9.3's auto-suppression: every region the user photographed in,
    /// on the day they photographed it.
    ///
    /// Runs on all samples, not just the far-away ones, and regardless of
    /// whether a suggestion is raised — a region only earns its way onto the
    /// "don't ask here" list through the ordinary visits that were never worth
    /// asking about. That is what makes the daily commute go quiet by itself.
    private func recordVisits(from samples: [TripPhotoSample]) {
        var seen = Set<String>()
        for sample in samples {
            let cell = TripRegionGrid.cellKey(
                latitude: sample.latitude, longitude: sample.longitude
            )
            let day = TripRegionSuppression.dayKey(for: sample.date)
            // One write per cell/day pair — a day out easily produces hundreds
            // of photos in the same cell.
            guard seen.insert("\(cell)@\(day)").inserted else { continue }
            TripRegionSuppression.recordVisit(cell: cell, on: sample.date)
        }
    }

    // MARK: - Suggestion

    private func raiseSuggestion(for outcome: TripAutoStartHeuristic.Outcome) async {
        let name = await Self.suggestedName(
            latitude: outcome.latitude, longitude: outcome.longitude
        )
        store(PendingStartSuggestion(
            suggestedName: name,
            regionCell: outcome.regionCell,
            travellingSince: outcome.travellingSince,
            raisedAt: Date()
        ))

        // Asked before posting, not after — a request added while the app has
        // no notification permission is simply dropped. This is a no-op unless
        // the status is still undetermined.
        await requestNotificationAuthorizationIfNeeded()

        // In the foreground the `TripView` banner already carries the
        // suggestion; a notification on top would just duplicate it.
        guard UIApplication.shared.applicationState != .active else { return }

        let content = UNMutableNotificationContent()
        content.title = "Sieht aus, als wärst du unterwegs"
        content.body = "\(name) – Trip Mode einschalten, damit neue Fotos automatisch ins Reise-Album wandern?"
        content.categoryIdentifier = Self.notificationCategoryId
        content.sound = .default

        let request = UNNotificationRequest(
            identifier: "trip.autostart.suggestion", content: content, trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }

    /// Builds the name prefill: the reverse-geocoded place plus month and year
    /// ("Nürburg (August 2026)"), mirroring `TripStartSheet`'s own suggestion
    /// format. Falls back to the plain date-based default when geocoding fails
    /// — offline, rate-limited, or a coordinate over open water.
    ///
    /// Uses `CLGeocoder` directly rather than `TripLocationProvider`: the
    /// coordinate is already known from the photos, so the provider's
    /// `CLLocationManager` would be dead weight.
    private static func suggestedName(latitude: Double, longitude: Double) async -> String {
        let location = CLLocation(latitude: latitude, longitude: longitude)
        let placemarks = try? await CLGeocoder().reverseGeocodeLocation(location)
        guard let placemark = placemarks?.first,
              let place = placemark.locality
                ?? placemark.subAdministrativeArea
                ?? placemark.administrativeArea
                ?? placemark.country
        else {
            return TripStore.defaultTripName()
        }
        let formatter = DateFormatter()
        formatter.dateFormat = "MMMM yyyy"
        return "\(place) (\(formatter.string(from: Date())))"
    }

    // MARK: - Notification actions

    /// Entry point for `Main.swift`'s notification delegate.
    ///
    /// "Trip starten" does **not** start the trip: it arms
    /// `shouldPresentStartSheet` so `TripView` opens the prefilled
    /// `TripStartSheet`, because the name the user confirms there becomes both
    /// an iOS and a server album. "Für diesen Ort nicht mehr fragen" silences
    /// the region for good (§9.3); a plain tap, like everywhere else in Trip
    /// Mode, is not an implicit yes and only clears the suggestion.
    public func handleNotificationAction(_ actionIdentifier: String) {
        switch actionIdentifier {
        case Self.startActionId:
            setPresentStartSheet(true)
        case Self.neverHereActionId:
            suppressCurrentRegion()
        default:
            dismissSuggestion()
        }
    }

    /// Requests notification permission if not yet determined. A denial only
    /// costs the notification path — `pendingSuggestion` is set either way, so
    /// the `TripView` banner still carries the suggestion.
    private func requestNotificationAuthorizationIfNeeded() async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .notDetermined else { return }
        _ = try? await center.requestAuthorization(options: [.alert, .sound])
    }

    // MARK: - Photo enumeration

    /// Collects the geotagged image assets created since `since`.
    ///
    /// Only the coordinate and the creation date are kept — the heuristic needs
    /// nothing else, and holding on to `PHAsset`s across the actor hop would be
    /// both heavier and unnecessary. Runs off the main thread, like the trip
    /// auto-add pass's own enumeration.
    private static func recentGeotaggedSamples(since: Date) async -> [TripPhotoSample] {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                let options = PHFetchOptions()
                options.predicate = NSPredicate(
                    format: "mediaType == %d AND creationDate >= %@",
                    PHAssetMediaType.image.rawValue, since as NSDate
                )
                options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]

                var samples: [TripPhotoSample] = []
                PHAsset.fetchAssets(with: .image, options: options).enumerateObjects { asset, _, _ in
                    guard let created = asset.creationDate,
                          let coordinate = asset.location?.coordinate
                    else { return }
                    samples.append(TripPhotoSample(
                        date: created,
                        latitude: coordinate.latitude,
                        longitude: coordinate.longitude
                    ))
                }
                continuation.resume(returning: samples)
            }
        }
    }
}
