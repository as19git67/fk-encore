import AppIntents
import Foundation
import FKPhotosLib

// The app's actions for Siri, the Shortcuts app, Spotlight and the Action
// button (#766, §20 E3).
//
// In the app target on purpose. They lived in the package once, bridged
// over with an `AppIntentsPackage`, and that worked from Xcode but not
// from TestFlight: the archive's metadata extraction left the package's
// intents out, and the installed app had no actions at all. Here they
// are extracted the ordinary way on every build. Each intent is one
// call into `IntentActions`; the work stays in the package.

// MARK: - Jetzt sichern

struct BackUpNowIntent: AppIntent {
    static let title: LocalizedStringResource = "Jetzt sichern"
    static let description = IntentDescription(
        "Sichert neue Fotos aus den verknüpften Alben auf den F4mil-Server.",
    )
    static let openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let said = await IntentActions.backUpNow()
        return .result(dialog: "\(said)")
    }
}

// MARK: - Fotos suchen

/// „Suche in F4mil Photos nach Kirchen in München": opens the search tab
/// with the query submitted. The search itself runs in the app.
struct SearchPhotosIntent: AppIntent {
    static let title: LocalizedStringResource = "Fotos suchen"
    static let description = IntentDescription(
        "Sucht in der Fotobibliothek, in natürlicher Sprache — Ort und Zeitraum werden erkannt.",
    )
    static let openAppWhenRun = true

    @Parameter(title: "Suchbegriff", requestValueDialog: "Wonach soll ich suchen?")
    var query: String

    static var parameterSummary: some ParameterSummary {
        Summary("Suche nach \(\.$query)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw $query.needsValueError("Wonach soll ich suchen?")
        }
        IntentActions.openSearch(query: trimmed)
        return .result()
    }
}

// MARK: - Rückblick zeigen

struct ShowLatestRecapIntent: AppIntent {
    static let title: LocalizedStringResource = "Rückblick zeigen"
    static let description = IntentDescription("Spielt den neuesten Rückblick ab.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let said = await IntentActions.showLatestRecap()
        return .result(dialog: "\(said)")
    }
}

// MARK: - Album öffnen

/// An album as Siri and Shortcuts see it: a name to pick from, an id to
/// open.
struct AlbumEntity: AppEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Album")
    static let defaultQuery = AlbumEntityQuery()

    let id: Int
    let name: String
    let photoCount: Int

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(
            title: "\(name)",
            subtitle: "\(photoCount == 1 ? "1 Foto" : "\(photoCount) Fotos")"
        )
    }

    init(_ album: IntentActions.AlbumRef) {
        id = album.id
        name = album.name
        photoCount = album.photoCount
    }
}

struct AlbumEntityQuery: EntityStringQuery {
    func entities(for identifiers: [Int]) async throws -> [AlbumEntity] {
        let wanted = Set(identifiers)
        return try await allAlbums().filter { wanted.contains($0.id) }
    }

    /// Siri's spoken name, matched loosely: „Urlaub" should find „Urlaub
    /// 2024" and „urlaub" alike.
    func entities(matching string: String) async throws -> [AlbumEntity] {
        let needle = string.folded
        return try await allAlbums().filter { $0.name.folded.contains(needle) }
    }

    func suggestedEntities() async throws -> [AlbumEntity] {
        Array(try await allAlbums().prefix(10))
    }

    private func allAlbums() async throws -> [AlbumEntity] {
        try await IntentActions.albums().map(AlbumEntity.init)
    }
}

struct OpenAlbumIntent: AppIntent {
    static let title: LocalizedStringResource = "Album öffnen"
    static let description = IntentDescription("Öffnet ein Album in F4mil Photos.")
    static let openAppWhenRun = true

    @Parameter(title: "Album", requestValueDialog: "Welches Album?")
    var album: AlbumEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Öffne \(\.$album)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        IntentActions.openAlbum(id: album.id)
        return .result()
    }
}

// MARK: - Person zeigen

struct PersonEntity: AppEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Person")
    static let defaultQuery = PersonEntityQuery()

    let id: Int
    let name: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }

    init(_ person: IntentActions.PersonRef) {
        id = person.id
        name = person.name
    }
}

struct PersonEntityQuery: EntityStringQuery {
    func entities(for identifiers: [Int]) async throws -> [PersonEntity] {
        let wanted = Set(identifiers)
        return try await allPersons().filter { wanted.contains($0.id) }
    }

    func entities(matching string: String) async throws -> [PersonEntity] {
        let needle = string.folded
        return try await allPersons().filter { $0.name.folded.contains(needle) }
    }

    func suggestedEntities() async throws -> [PersonEntity] {
        Array(try await allPersons().prefix(10))
    }

    private func allPersons() async throws -> [PersonEntity] {
        try await IntentActions.persons().map(PersonEntity.init)
    }
}

struct ShowPersonIntent: AppIntent {
    static let title: LocalizedStringResource = "Fotos einer Person zeigen"
    static let description = IntentDescription("Zeigt die Fotos einer Person in F4mil Photos.")
    static let openAppWhenRun = true

    @Parameter(title: "Person", requestValueDialog: "Wessen Fotos?")
    var person: PersonEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Zeige Fotos von \(\.$person)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        IntentActions.openPerson(id: person.id)
        return .result()
    }
}

// MARK: - Gruppen-Review

struct OpenReviewQueueIntent: AppIntent {
    static let title: LocalizedStringResource = "Gruppen-Review öffnen"
    static let description = IntentDescription("Öffnet die ähnlichen Fotos, die auf eine Entscheidung warten.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        IntentActions.openReviewQueue()
        return .result()
    }
}

// MARK: - Das hier merken (§20, E3)

/// Remembering the place you are standing on, in one tap: from the
/// Shortcuts app, from Siri, from the Action button. The sheet needs the
/// app: the coordinate is asked for with the app's own location
/// permission, and the note is typed.
struct RememberHereIntent: AppIntent {
    static let title: LocalizedStringResource = "Das hier merken"
    static let description = IntentDescription(
        "Merkt den Ort, an dem du gerade stehst, in den Ideen der Urlaubsplanung.",
    )
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        IntentActions.rememberHere()
        return .result()
    }
}

// MARK: - App Shortcuts

/// The app's shortcuts for the Shortcuts app, Siri, Spotlight and the Action
/// button.
///
/// Phrases are what Siri listens for; each must contain the app name.
/// Entity-taking intents (album, person) are not listed here on purpose:
/// an App Shortcut phrase can carry an entity only as an enumerated
/// parameter, and albums are open-ended. They stay reachable through the
/// Shortcuts app and through Siri's own „Öffne Album Urlaub in F4mil Photos"
/// resolution once the app has been used once.
struct FKPhotosShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: RememberHereIntent(),
            phrases: [
                "Das hier merken in \(.applicationName)",
                "Merke diesen Ort in \(.applicationName)",
            ],
            shortTitle: "Das hier merken",
            systemImageName: "mappin.and.ellipse"
        )
        AppShortcut(
            intent: BackUpNowIntent(),
            phrases: [
                "Jetzt sichern mit \(.applicationName)",
                "Fotos sichern mit \(.applicationName)",
                "\(.applicationName) synchronisieren",
            ],
            shortTitle: "Jetzt sichern",
            systemImageName: "arrow.triangle.2.circlepath"
        )
        AppShortcut(
            intent: SearchPhotosIntent(),
            // A phrase may carry a parameter only when it is an AppEnum or
            // AppEntity; the free-text query is asked for after the phrase.
            phrases: [
                "Suche in \(.applicationName)",
                "Fotos suchen in \(.applicationName)",
            ],
            shortTitle: "Fotos suchen",
            systemImageName: "magnifyingglass"
        )
        AppShortcut(
            intent: ShowLatestRecapIntent(),
            phrases: [
                "Zeige den Rückblick in \(.applicationName)",
                "Rückblick in \(.applicationName)",
            ],
            shortTitle: "Rückblick zeigen",
            systemImageName: "sparkles"
        )
        AppShortcut(
            intent: OpenReviewQueueIntent(),
            phrases: [
                "Gruppen-Review in \(.applicationName)",
                "Fotos aussortieren in \(.applicationName)",
            ],
            shortTitle: "Gruppen-Review",
            systemImageName: "checklist"
        )
    }
}

private extension String {
    /// Case- and diacritic-insensitive form for matching a spoken name.
    var folded: String {
        folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
    }
}
