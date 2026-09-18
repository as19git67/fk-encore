import Foundation

/// What the app's intents do, without the intents (#766).
///
/// The `AppIntent` types themselves live in the app target
/// (`ios/App/Intents.swift`). They used to live here, in the package,
/// bridged over with an `AppIntentsPackage` — and that worked from Xcode
/// and not from TestFlight: the archive's metadata extraction did not
/// pick the intents out of the package, so the app had no actions in
/// the Shortcuts app, and Siri knew nothing. An intent in the app target
/// is extracted by the ordinary path on every build.
///
/// So the package offers the *actions* as plain functions, and the
/// intents are thin: one call each. Everything visible still goes
/// through the deep-link router, so „Zeige Album Urlaub" from Siri lands
/// on the same screen as a Spotlight hit.
public enum IntentActions {

    // MARK: - Jetzt sichern

    /// Start a sync run without opening the app. Not awaited: a first
    /// backup can take many minutes and an intent has seconds; the sync
    /// engine holds its own background-task assertion. Returns what can
    /// be known right away, as the sentence to speak.
    @MainActor
    public static func backUpNow() async -> String {
        guard PhotoSyncPreferences.syncEnabled else {
            return "Die automatische Synchronisierung ist ausgeschaltet. Schalte sie in F4mil Photos unter Einstellungen ein."
        }
        guard await BackgroundSyncManager.networkAllowsUpload() else {
            return PhotoSyncPreferences.wifiOnly
                ? "Kein WLAN. Die Sicherung läuft nur über WLAN, solange „Nur WLAN“ eingeschaltet ist."
                : "Keine Netzwerkverbindung."
        }
        if SyncProgress.shared.isActive {
            return "Eine Sicherung läuft bereits."
        }
        Task { try? await BackgroundSyncManager.shared.runFullSync() }
        return "Sicherung gestartet."
    }

    // MARK: - Screens

    @MainActor
    public static func openSearch(query: String) {
        AppDeepLinkRouter.shared.open(.search(query: query))
    }

    @MainActor
    public static func openAlbum(id: Int) {
        AppDeepLinkRouter.shared.open(.album(id: id))
    }

    @MainActor
    public static func openPerson(id: Int) {
        AppDeepLinkRouter.shared.open(.person(id: id))
    }

    @MainActor
    public static func openReviewQueue() {
        AppDeepLinkRouter.shared.open(.reviewQueue)
    }

    /// Opens the newest recap in the player and returns its title, or
    /// opens the list and returns the sentence that explains why.
    @MainActor
    public static func showLatestRecap() async -> String {
        let response: ListRecapsResponse
        do {
            response = try await APIClient.shared.get("/recaps")
        } catch {
            // Offline or signed out: the list screen explains itself.
            AppDeepLinkRouter.shared.open(.recaps)
            return "Die Rückblicke konnten gerade nicht geladen werden."
        }
        guard let newest = response.recaps.first(where: { $0.dismissed_at == nil }) ?? response.recaps.first else {
            AppDeepLinkRouter.shared.open(.recaps)
            return "Es gibt noch keinen Rückblick."
        }
        AppDeepLinkRouter.shared.open(.recap(id: newest.id))
        return newest.title
    }

    /// "Das hier merken": asks the app to open the idea sheet for the
    /// place the phone is at. The sheet talks to the server, not this.
    @MainActor
    public static func rememberHere() {
        TripIdeaCaptureRequest.shared.request()
    }

    // MARK: - Entities

    public struct AlbumRef: Sendable, Identifiable {
        public let id: Int
        public let name: String
        public let photoCount: Int
    }

    public struct PersonRef: Sendable, Identifiable {
        public let id: Int
        public let name: String
    }

    /// The albums, for Siri and Shortcuts to pick from. A phone with the
    /// app installed has a session, and the list is small.
    public static func albums() async throws -> [AlbumRef] {
        let response: ListAlbumsResponse = try await APIClient.shared.get("/albums")
        return response.albums.map { AlbumRef(id: $0.id, name: $0.name, photoCount: $0.photo_count) }
    }

    /// Named people only — an unnamed cluster is nothing anyone asks for.
    public static func persons() async throws -> [PersonRef] {
        let response: ListPersonsResponse = try await APIClient.shared.get("/persons", query: ["limit": "500"])
        return response.persons
            .filter { $0.name != "Unbenannt" }
            .map { PersonRef(id: $0.id, name: $0.name) }
    }
}
