import Photos
import PhotosUI
import SwiftUI
import UIKit

/// Photo access limited to a selection (#768, further idea 4a).
///
/// The sync accepted `.limited` all along but never said so: „Alle Fotos
/// hochladen" quietly meant „alle *freigegebenen* Fotos", and iOS put its own
/// „Weiterhin beschränken / Mehr auswählen" alert over the app on every
/// launch — which read as a bug in the app. `Info.plist` now sets
/// `PHPhotoLibraryPreventAutomaticLimitedAccessAlert`, and this is the
/// replacement: the state, spelled out where the sync is configured, with
/// the two ways out of it.
@MainActor
@Observable
final class LimitedLibraryAccess {
    static let shared = LimitedLibraryAccess()

    private(set) var status: PHAuthorizationStatus = PHPhotoLibrary.authorizationStatus(for: .readWrite)

    var isLimited: Bool { status == .limited }

    private init() {}

    func refresh() {
        status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    }

    /// The system's own picker for extending the selection. Needs a view
    /// controller to present from, which SwiftUI does not hand out; the
    /// front-most one of the active scene is the one the user is looking at.
    func presentPicker() {
        guard let presenter = Self.frontViewController() else { return }
        PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: presenter)
    }

    /// Full access is granted in Settings, not in the app.
    func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    private static func frontViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        guard var top = scene?.keyWindow?.rootViewController else { return nil }
        while let presented = top.presentedViewController { top = presented }
        return top
    }
}

/// Picks up a changed selection without a restart.
///
/// Extending the selection in the picker (or in Settings) fires a library
/// change; under limited access that is the only way a new photo can appear,
/// so it is worth a sync straight away rather than at the next foreground
/// cycle. Debounced: the picker's dismissal can deliver several changes in a
/// row, and each `runFullSync` is a whole pipeline.
final class LimitedLibraryChangeObserver: NSObject, PHPhotoLibraryChangeObserver {
    static let shared = LimitedLibraryChangeObserver()

    private var registered = false
    private var pending: Task<Void, Never>?

    private override init() { super.init() }

    func startIfNeeded() {
        guard !registered else { return }
        registered = true
        PHPhotoLibrary.shared().register(self)
    }

    func photoLibraryDidChange(_ changeInstance: PHChange) {
        Task { @MainActor in
            LimitedLibraryAccess.shared.refresh()
            guard LimitedLibraryAccess.shared.isLimited, PhotoSyncPreferences.syncEnabled else { return }
            pending?.cancel()
            pending = Task {
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled else { return }
                try? await BackgroundSyncManager.shared.runFullSync()
            }
        }
    }
}

/// The row in the sync settings: what limited access means here, and the two
/// ways to change it.
struct LimitedLibraryAccessSection: View {
    @State private var access = LimitedLibraryAccess.shared

    var body: some View {
        if access.isLimited {
            Section {
                Label {
                    Text("Zugriff auf ausgewählte Fotos beschränkt")
                } icon: {
                    Image(systemName: "photo.badge.exclamationmark")
                        .foregroundStyle(.orange)
                }
                Button("Auswahl ändern…") {
                    access.presentPicker()
                }
                Button("Vollen Zugriff erlauben") {
                    access.openSettings()
                }
            } footer: {
                Text("F4mil Photos sieht nur die Fotos, die du in der Auswahl freigegeben hast. Verknüpfte Alben und „Alle Fotos hochladen“ meinen dann diese Auswahl; neu aufgenommene Fotos werden erst gesichert, wenn du sie hinzufügst.")
            }
        }
    }
}
