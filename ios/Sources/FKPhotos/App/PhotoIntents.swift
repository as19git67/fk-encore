import AppIntents
import Foundation

/// The photo app's actions for Siri, the Shortcuts app, Spotlight and the
/// Action button (#766).
///
/// Every intent that shows something ends in the same place: an
/// `AppDeepLink` handed to `AppDeepLinkRouter`, so „Zeige Album Urlaub" from
/// Siri and a tap on a Spotlight hit land on the identical screen. The one
/// exception is „Jetzt sichern", which needs no screen at all.
///
/// Public because App Shortcuts have to be declared in the app target
/// (`Main.swift`), which lives in another module; `FKPhotosIntents`
/// (`TripIntents.swift`) is the package that carries them there.

// MARK: - Jetzt sichern

/// Start a sync run without opening the app.
///
/// The run itself is not awaited: a first backup can take many minutes and
/// an intent has seconds. The sync engine holds its own background-task
/// assertion (`BackgroundSyncManager.runFullSync`), so the run outlives this
/// call the same way it outlives the settings screen's own button. What is
/// answered is what can be known right away: that it started, or why not.
public struct BackUpNowIntent: AppIntent {
    public static let title: LocalizedStringResource = "Jetzt sichern"
    public static let description = IntentDescription(
        "Sichert neue Fotos aus den verknüpften Alben auf den F4mil-Server.",
    )
    public static let openAppWhenRun = false

    public init() {}

    @MainActor
    public func perform() async throws -> some IntentResult & ProvidesDialog {
        guard PhotoSyncPreferences.syncEnabled else {
            return .result(dialog: "Die automatische Synchronisierung ist ausgeschaltet. Schalte sie in F4mil Photos unter Einstellungen ein.")
        }
        guard await BackgroundSyncManager.networkAllowsUpload() else {
            let reason: IntentDialog = PhotoSyncPreferences.wifiOnly
                ? "Kein WLAN. Die Sicherung läuft nur über WLAN, solange „Nur WLAN“ eingeschaltet ist."
                : "Keine Netzwerkverbindung."
            return .result(dialog: reason)
        }
        if SyncProgress.shared.isActive {
            return .result(dialog: "Eine Sicherung läuft bereits.")
        }
        Task { try? await BackgroundSyncManager.shared.runFullSync() }
        return .result(dialog: "Sicherung gestartet.")
    }
}

// MARK: - Fotos suchen

/// „Suche in F4mil Photos nach Kirchen in München": opens the search tab
/// with the query submitted. The search itself runs in the app — it is a
/// round trip through the embedding service and wants the results screen,
/// not a spoken list.
public struct SearchPhotosIntent: AppIntent {
    public static let title: LocalizedStringResource = "Fotos suchen"
    public static let description = IntentDescription(
        "Sucht in der Fotobibliothek, in natürlicher Sprache — Ort und Zeitraum werden erkannt.",
    )
    public static let openAppWhenRun = true

    @Parameter(title: "Suchbegriff", requestValueDialog: "Wonach soll ich suchen?")
    public var query: String

    public init() {}

    public init(query: String) {
        self.query = query
    }

    public static var parameterSummary: some ParameterSummary {
        Summary("Suche nach \(\.$query)")
    }

    @MainActor
    public func perform() async throws -> some IntentResult {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw $query.needsValueError("Wonach soll ich suchen?")
        }
        AppDeepLinkRouter.shared.open(.search(query: trimmed))
        return .result()
    }
}

// MARK: - Rückblick zeigen

/// Opens the newest recap in the player. Recaps are made server-side; the
/// list is asked for here so the intent can say when there is none yet
/// rather than open an empty list.
public struct ShowLatestRecapIntent: AppIntent {
    public static let title: LocalizedStringResource = "Rückblick zeigen"
    public static let description = IntentDescription(
        "Spielt den neuesten Rückblick ab.",
    )
    public static let openAppWhenRun = true

    public init() {}

    @MainActor
    public func perform() async throws -> some IntentResult & ProvidesDialog {
        let response: ListRecapsResponse
        do {
            response = try await APIClient.shared.get("/recaps")
        } catch {
            // Offline or signed out: the list screen explains itself.
            AppDeepLinkRouter.shared.open(.recaps)
            return .result(dialog: "Die Rückblicke konnten gerade nicht geladen werden.")
        }
        guard let newest = response.recaps.first(where: { $0.dismissed_at == nil }) ?? response.recaps.first else {
            AppDeepLinkRouter.shared.open(.recaps)
            return .result(dialog: "Es gibt noch keinen Rückblick.")
        }
        AppDeepLinkRouter.shared.open(.recap(id: newest.id))
        return .result(dialog: "\(newest.title)")
    }
}

// MARK: - Album öffnen

/// An album as Siri and Shortcuts see it: a name to pick from, an id to
/// open. The query answers from the server — a phone with the app installed
/// has a session, and the list is small.
public struct AlbumEntity: AppEntity {
    public static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Album")
    public static let defaultQuery = AlbumEntityQuery()

    public let id: Int
    public let name: String
    public let photoCount: Int

    public var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(
            title: "\(name)",
            subtitle: "\(photoCount == 1 ? "1 Foto" : "\(photoCount) Fotos")"
        )
    }

    init(_ album: Album) {
        id = album.id
        name = album.name
        photoCount = album.photo_count
    }
}

public struct AlbumEntityQuery: EntityStringQuery {
    public init() {}

    public func entities(for identifiers: [Int]) async throws -> [AlbumEntity] {
        let wanted = Set(identifiers)
        return try await allAlbums().filter { wanted.contains($0.id) }
    }

    /// Siri's spoken name, matched loosely: „Urlaub" should find „Urlaub
    /// 2024" and „urlaub" alike.
    public func entities(matching string: String) async throws -> [AlbumEntity] {
        let needle = string.folded
        return try await allAlbums().filter { $0.name.folded.contains(needle) }
    }

    public func suggestedEntities() async throws -> [AlbumEntity] {
        Array(try await allAlbums().prefix(10))
    }

    private func allAlbums() async throws -> [AlbumEntity] {
        let response: ListAlbumsResponse = try await APIClient.shared.get("/albums")
        return response.albums.map(AlbumEntity.init)
    }
}

public struct OpenAlbumIntent: AppIntent {
    public static let title: LocalizedStringResource = "Album öffnen"
    public static let description = IntentDescription("Öffnet ein Album in F4mil Photos.")
    public static let openAppWhenRun = true

    @Parameter(title: "Album", requestValueDialog: "Welches Album?")
    public var album: AlbumEntity

    public init() {}

    public static var parameterSummary: some ParameterSummary {
        Summary("Öffne \(\.$album)")
    }

    @MainActor
    public func perform() async throws -> some IntentResult {
        AppDeepLinkRouter.shared.open(.album(id: album.id))
        return .result()
    }
}

// MARK: - Person zeigen

public struct PersonEntity: AppEntity {
    public static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Person")
    public static let defaultQuery = PersonEntityQuery()

    public let id: Int
    public let name: String

    public var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }
}

public struct PersonEntityQuery: EntityStringQuery {
    public init() {}

    public func entities(for identifiers: [Int]) async throws -> [PersonEntity] {
        let wanted = Set(identifiers)
        return try await allPersons().filter { wanted.contains($0.id) }
    }

    public func entities(matching string: String) async throws -> [PersonEntity] {
        let needle = string.folded
        return try await allPersons().filter { $0.name.folded.contains(needle) }
    }

    public func suggestedEntities() async throws -> [PersonEntity] {
        Array(try await allPersons().prefix(10))
    }

    /// Named people only — an unnamed cluster is nothing anyone asks for.
    private func allPersons() async throws -> [PersonEntity] {
        let response: ListPersonsResponse = try await APIClient.shared.get("/persons", query: ["limit": "500"])
        return response.persons
            .filter { $0.name != "Unbenannt" }
            .map { PersonEntity(id: $0.id, name: $0.name) }
    }
}

public struct ShowPersonIntent: AppIntent {
    public static let title: LocalizedStringResource = "Fotos einer Person zeigen"
    public static let description = IntentDescription("Zeigt die Fotos einer Person in F4mil Photos.")
    public static let openAppWhenRun = true

    @Parameter(title: "Person", requestValueDialog: "Wessen Fotos?")
    public var person: PersonEntity

    public init() {}

    public static var parameterSummary: some ParameterSummary {
        Summary("Zeige Fotos von \(\.$person)")
    }

    @MainActor
    public func perform() async throws -> some IntentResult {
        AppDeepLinkRouter.shared.open(.person(id: person.id))
        return .result()
    }
}

// MARK: - Gruppen-Review

public struct OpenReviewQueueIntent: AppIntent {
    public static let title: LocalizedStringResource = "Gruppen-Review öffnen"
    public static let description = IntentDescription("Öffnet die ähnlichen Fotos, die auf eine Entscheidung warten.")
    public static let openAppWhenRun = true

    public init() {}

    @MainActor
    public func perform() async throws -> some IntentResult {
        AppDeepLinkRouter.shared.open(.reviewQueue)
        return .result()
    }
}

private extension String {
    /// Case- and diacritic-insensitive form for matching a spoken name.
    var folded: String {
        folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
    }
}
