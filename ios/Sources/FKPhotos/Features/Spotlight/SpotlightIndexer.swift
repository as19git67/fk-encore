import CoreSpotlight
import Foundation
import Observation
import UniformTypeIdentifiers

/// Puts the library into the phone's own search field (#768, further idea 2).
///
/// Three sets, each in its own Spotlight domain so it can be dropped alone:
///
/// - **Photos with text** — text recognised inside the image (`photo_ocr`,
///   #1029) or a written description. A search for „Hauptbahnhof" on the home
///   screen finds the sign. This is the valuable set and the large one:
///   tens of thousands of photos have no text and never appear here, the
///   ones that do are fed by `GET /photos/spotlight-index`, a delta walked by
///   cursor after every sync so a library is never re-read whole. Deletions
///   cannot travel through a delta (the OCR row dies with the photo), so
///   `/spotlight-index/ids` is diffed against the ids this index holds.
/// - **People** and **albums** — small lists, re-indexed in full whenever
///   the app loads them.
///
/// What is *not* done, and why:
/// - No thumbnails on photo items. Tens of thousands of thumbnails would be
///   hundreds of megabytes of index; a Spotlight row that shows the app icon,
///   a text snippet and the date is still a hit.
/// - No `expirationDate` short of forever: the default is a month, after
///   which Spotlight silently forgets everything.
/// - Text is capped server-side (the first lines are what a query matches
///   on) and the index is only ever appended in batches, so an interrupted
///   first run resumes at its cursor rather than starting over.
///
/// Privacy: recognised text is exactly the kind of content that carries
/// personal data (a photographed letter, an invoice, a business card). The
/// Spotlight index stays on the device and is never synced, but a phone
/// search then surfaces those snippets — so the photo-text part is an explicit
/// opt-in (`SpotlightPreferences.photoTextEnabled`), and turning it off, like
/// signing out, wipes the domain.
@MainActor
@Observable
final class SpotlightIndexer {
    static let shared = SpotlightIndexer()

    enum Domain: String, CaseIterable {
        case photo, person, album
    }

    /// Progress of the photo delta, for the settings screen.
    private(set) var isIndexingPhotos = false
    private(set) var indexedPhotoCount: Int = SpotlightIndexState.indexedPhotoIds.count
    private(set) var lastPhotoRun: Date? = SpotlightIndexState.lastPhotoRun
    private(set) var lastError: String?

    /// Not more often than this unless forced: every foreground and every
    /// sync would otherwise ask the server for a delta that is nearly always
    /// empty.
    static let minimumInterval: TimeInterval = 15 * 60
    /// Rows per delta page and per Spotlight batch. Spotlight takes larger
    /// batches, but a few hundred keeps memory flat on the first run of a
    /// large library.
    static let pageSize = 500

    private var photoTask: Task<Void, Never>?

    private init() {}

    // MARK: - Photos with text

    /// Walk the delta from the stored cursor and reconcile deletions. Safe
    /// to call from anywhere; concurrent calls join the running one.
    func syncPhotos(force: Bool = false) async {
        guard SpotlightPreferences.photoTextEnabled, CSSearchableIndex.isIndexingAvailable() else { return }
        if let running = photoTask {
            await running.value
            return
        }
        if !force, let last = lastPhotoRun, Date().timeIntervalSince(last) < Self.minimumInterval {
            return
        }
        let task = Task { await runPhotoSync() }
        photoTask = task
        await task.value
        photoTask = nil
    }

    private func runPhotoSync() async {
        isIndexingPhotos = true
        lastError = nil
        defer { isIndexingPhotos = false }
        let index = CSSearchableIndex.default()
        var cursor = SpotlightIndexState.photoCursor
        var indexed = SpotlightIndexState.indexedPhotoIds

        do {
            while true {
                var query = ["limit": String(Self.pageSize)]
                if let cursor { query["cursor"] = cursor }
                let page: SpotlightIndexResponse = try await APIClient.shared.get("/photos/spotlight-index", query: query)
                if page.items.isEmpty { break }

                let items = page.items.map { SpotlightItems.photo($0) }
                try await index.indexSearchableItems(items)
                for item in page.items { indexed.insert(item.id) }
                cursor = page.items.last?.cursor
                // Persist after every batch so an interrupted first run resumes
                // here rather than at the beginning.
                SpotlightIndexState.photoCursor = cursor
                SpotlightIndexState.indexedPhotoIds = indexed
                indexedPhotoCount = indexed.count

                guard page.next_cursor != nil else { break }
            }

            // Reconcile deletions and lost access: whatever this index holds
            // that the server no longer lists.
            let current: SpotlightIdsResponse = try await APIClient.shared.get("/photos/spotlight-index/ids")
            let keep = Set(current.ids)
            let gone = indexed.subtracting(keep)
            if !gone.isEmpty {
                try await index.deleteSearchableItems(withIdentifiers: gone.map(SpotlightItems.photoIdentifier))
                indexed.subtract(gone)
                SpotlightIndexState.indexedPhotoIds = indexed
                indexedPhotoCount = indexed.count
            }

            lastPhotoRun = Date()
            SpotlightIndexState.lastPhotoRun = lastPhotoRun
        } catch {
            lastError = error.localizedDescription
        }
    }

    // MARK: - People and albums

    /// Re-index the people list in full. Called by `PersonsViewModel` after
    /// each load; the list is small enough that a diff would cost more than
    /// it saves. Persons the list no longer contains (merged, ignored) are
    /// dropped by replacing the whole domain.
    func indexPersons(_ persons: [PersonWithFaceCount]) async {
        guard SpotlightPreferences.peopleAndAlbumsEnabled, CSSearchableIndex.isIndexingAvailable() else { return }
        await replaceDomain(.person, with: persons.compactMap { SpotlightItems.person($0) })
    }

    func indexAlbums(_ albums: [Album]) async {
        guard SpotlightPreferences.peopleAndAlbumsEnabled, CSSearchableIndex.isIndexingAvailable() else { return }
        await replaceDomain(.album, with: albums.map { SpotlightItems.album($0) })
    }

    private func replaceDomain(_ domain: Domain, with items: [CSSearchableItem]) async {
        let index = CSSearchableIndex.default()
        do {
            try await index.deleteSearchableItems(withDomainIdentifiers: [domain.rawValue])
            if !items.isEmpty {
                try await index.indexSearchableItems(items)
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    // MARK: - Wiping

    /// Drop one set — a toggle was turned off.
    func wipe(_ domain: Domain) async {
        try? await CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: [domain.rawValue])
        if domain == .photo {
            SpotlightIndexState.reset()
            indexedPhotoCount = 0
            lastPhotoRun = nil
        }
    }

    /// Drop everything — sign-out. The index is per device, the API is per
    /// user; a second account on the same phone must not search the first
    /// one's photos.
    func wipeAll() async {
        photoTask?.cancel()
        try? await CSSearchableIndex.default().deleteAllSearchableItems()
        SpotlightIndexState.reset()
        indexedPhotoCount = 0
        lastPhotoRun = nil
    }
}

// MARK: - Items

/// How each kind of thing is described to Spotlight. Pure, so the shape is
/// testable: the identifier round-trips through `AppDeepLink`, the title is
/// the first line of text, and so on.
enum SpotlightItems {
    static let photoPrefix = "photo:"
    static let personPrefix = "person:"
    static let albumPrefix = "album:"

    static func photoIdentifier(_ id: Int) -> String { "\(photoPrefix)\(id)" }

    /// The deep link a Spotlight hit opens, from its unique identifier.
    /// Nil for an identifier this app did not write.
    static func deepLink(forIdentifier identifier: String) -> AppDeepLink? {
        if identifier.hasPrefix(photoPrefix) {
            return Int(identifier.dropFirst(photoPrefix.count)).map { .photo(id: $0) }
        }
        if identifier.hasPrefix(personPrefix) {
            return Int(identifier.dropFirst(personPrefix.count)).map { .person(id: $0) }
        }
        if identifier.hasPrefix(albumPrefix) {
            return Int(identifier.dropFirst(albumPrefix.count)).map { .album(id: $0) }
        }
        return nil
    }

    /// What the row says: the first line of recognised text, or the
    /// description when there is no text. The rest goes into the body, and
    /// the people on the photo become keywords so a name finds the photo too.
    static func photoAttributes(_ item: SpotlightIndexItem) -> CSSearchableItemAttributeSet {
        let attributes = CSSearchableItemAttributeSet(contentType: .image)
        let lines = item.text
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let description = item.description?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        if let first = lines.first {
            attributes.title = String(first.prefix(80))
            let rest = lines.dropFirst().joined(separator: " ")
            attributes.contentDescription = [description, rest]
                .filter { !$0.isEmpty }
                .joined(separator: " — ")
        } else {
            attributes.title = String(description.prefix(80))
            attributes.contentDescription = description.count > 80 ? description : nil
        }
        // `textContent` is what Spotlight matches full text on; the title
        // and description alone would only match their own words.
        attributes.textContent = [description, item.text].filter { !$0.isEmpty }.joined(separator: "\n")
        attributes.keywords = item.person_names.isEmpty ? nil : item.person_names
        if let takenAt = item.taken_at, let date = ISO8601DateFormatter.spotlight.date(from: takenAt) {
            attributes.contentCreationDate = date
        }
        return attributes
    }

    static func photo(_ item: SpotlightIndexItem) -> CSSearchableItem {
        let searchable = CSSearchableItem(
            uniqueIdentifier: photoIdentifier(item.id),
            domainIdentifier: SpotlightIndexer.Domain.photo.rawValue,
            attributeSet: photoAttributes(item)
        )
        searchable.expirationDate = .distantFuture
        return searchable
    }

    static func person(_ person: PersonWithFaceCount) -> CSSearchableItem? {
        // An unnamed cluster is not something anyone searches for by name.
        guard person.name != "Unbenannt" else { return nil }
        let attributes = CSSearchableItemAttributeSet(contentType: .contact)
        attributes.title = person.name
        attributes.contentDescription = "Person in F4mil Photos"
        let searchable = CSSearchableItem(
            uniqueIdentifier: "\(personPrefix)\(person.id)",
            domainIdentifier: SpotlightIndexer.Domain.person.rawValue,
            attributeSet: attributes
        )
        searchable.expirationDate = .distantFuture
        return searchable
    }

    static func album(_ album: Album) -> CSSearchableItem {
        let attributes = CSSearchableItemAttributeSet(contentType: .folder)
        attributes.title = album.name
        let count = album.photo_count == 1 ? "1 Foto" : "\(album.photo_count) Fotos"
        attributes.contentDescription = [album.description, count]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " — ")
        let searchable = CSSearchableItem(
            uniqueIdentifier: "\(albumPrefix)\(album.id)",
            domainIdentifier: SpotlightIndexer.Domain.album.rawValue,
            attributeSet: attributes
        )
        searchable.expirationDate = .distantFuture
        return searchable
    }
}

// MARK: - Wire types

struct SpotlightIndexItem: Decodable, Sendable {
    let id: Int
    let taken_at: String?
    let text: String
    let description: String?
    let person_names: [String]
    let cursor: String
}

struct SpotlightIndexResponse: Decodable, Sendable {
    let items: [SpotlightIndexItem]
    let next_cursor: String?
}

struct SpotlightIdsResponse: Decodable, Sendable {
    let ids: [Int]
}

// MARK: - Persisted state

/// The cursor and the id set of the photo index. Kept in `UserDefaults`
/// (the id set as a compact `Data` blob — ten thousand ids are 80 KB, not
/// a plist of ten thousand numbers) so the delta resumes across launches.
enum SpotlightIndexState {
    private static let cursorKey = "spotlight.photoCursor"
    private static let idsKey = "spotlight.photoIds"
    private static let lastRunKey = "spotlight.photoLastRun"

    static var photoCursor: String? {
        get { UserDefaults.standard.string(forKey: cursorKey) }
        set { UserDefaults.standard.set(newValue, forKey: cursorKey) }
    }

    static var lastPhotoRun: Date? {
        get { UserDefaults.standard.object(forKey: lastRunKey) as? Date }
        set { UserDefaults.standard.set(newValue, forKey: lastRunKey) }
    }

    static var indexedPhotoIds: Set<Int> {
        get {
            guard let data = UserDefaults.standard.data(forKey: idsKey) else { return [] }
            return decodeIds(data)
        }
        set { UserDefaults.standard.set(encodeIds(newValue), forKey: idsKey) }
    }

    static func reset() {
        UserDefaults.standard.removeObject(forKey: cursorKey)
        UserDefaults.standard.removeObject(forKey: idsKey)
        UserDefaults.standard.removeObject(forKey: lastRunKey)
    }

    static func encodeIds(_ ids: Set<Int>) -> Data {
        var data = Data(capacity: ids.count * 8)
        for id in ids.sorted() {
            var value = Int64(id).littleEndian
            withUnsafeBytes(of: &value) { data.append(contentsOf: $0) }
        }
        return data
    }

    static func decodeIds(_ data: Data) -> Set<Int> {
        var ids = Set<Int>()
        var offset = 0
        while offset + 8 <= data.count {
            let value = data.subdata(in: offset..<offset + 8).withUnsafeBytes { $0.loadUnaligned(as: Int64.self) }
            ids.insert(Int(Int64(littleEndian: value)))
            offset += 8
        }
        return ids
    }
}

/// The switches. Photo text is opt-in (see the privacy note on
/// `SpotlightIndexer`); people and albums are on, since a name or an album
/// title in the system search is what anyone would expect of a photo app.
enum SpotlightPreferences {
    private static let photoTextKey = "spotlight.photoTextEnabled"
    private static let peopleAndAlbumsKey = "spotlight.peopleAndAlbumsEnabled"

    static var photoTextEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: photoTextKey) }
        set { UserDefaults.standard.set(newValue, forKey: photoTextKey) }
    }

    static var peopleAndAlbumsEnabled: Bool {
        get { (UserDefaults.standard.object(forKey: peopleAndAlbumsKey) as? Bool) ?? true }
        set { UserDefaults.standard.set(newValue, forKey: peopleAndAlbumsKey) }
    }
}

extension ISO8601DateFormatter {
    /// Accepts both `2026-09-17T10:00:00.000Z` and the second-precision form.
    static let spotlight: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
