import Photos

/// Reacts to photo-library changes while a trip is active: runs the trip
/// auto-add pass so a freshly-taken photo lands in the trip album promptly
/// (Etappe 1c), and — only when something was actually added — kicks off a
/// sync so it uploads without waiting for the next foreground/background cycle.
///
/// The auto-add pass is also run from `BackgroundSyncManager.runFullSync` as a
/// catch-up, so a change missed while the app was suspended is picked up on the
/// next launch/resume regardless of this observer.
final class TripPhotoLibraryObserver: NSObject, PHPhotoLibraryChangeObserver {
    static let shared = TripPhotoLibraryObserver()

    private var registered = false

    private override init() { super.init() }

    /// Registers with the photo library exactly once. Safe to call before photo
    /// authorization — changes are only delivered once access is granted.
    func startIfNeeded() {
        guard !registered else { return }
        registered = true
        PHPhotoLibrary.shared().register(self)
    }

    func photoLibraryDidChange(_ changeInstance: PHChange) {
        // Called on an arbitrary queue; hop to the main actor to read the store.
        Task { @MainActor in
            guard TripStore.shared.isActive else { return }
            let added = await TripStore.shared.runAutoAddPass()
            guard added > 0 else { return }
            // Adding to the album itself fires another change; that follow-up
            // pass finds nothing new (already handled) and returns 0, so this
            // does not loop. Uploading does not modify the local library.
            try? await BackgroundSyncManager.shared.runFullSync()
        }
    }
}
