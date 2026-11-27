import Foundation
import Network

/// The plan, kept on the phone (§3.9).
///
/// "Ein fertiger Plan lässt sich komplett aufs iPhone laden und
/// funktioniert im Ausland ohne Datenverbindung." What makes that
/// affordable is the coarse resolution (§4.1): blocks, labels and
/// durations have nothing in them that goes stale between the hotel
/// wifi and the third street corner, because there were never any
/// minute-precise times to go stale.
///
/// The bundle is written to disk as it came from the server, one file
/// per plan, and read back when a request cannot be made. It is
/// deliberately *not* a cache in front of every call: a plan silently
/// served from disk while the network is fine would hide changes
/// somebody else made (§6.3). It is the answer to "there is no
/// network", and the screen says so whenever it is used.
struct TripOfflineBundle: Codable, Sendable {
    /// When the server assembled it, ISO-8601.
    let generatedAt: String
    let plan: TripPlan
    /// The trip as its itinerary reads it, which is where a trip opens.
    /// Optional: a bundle stored by an older build has none, and is
    /// still a plan.
    var itinerary: TripItineraryResponse? = nil
    /// The trip's paperwork as the list shows it to this traveller. The
    /// files of the readable ones are kept beside the bundle (offline
    /// review, F3). Nil from an older server.
    var documents: [TripDocument]? = nil
    let light: [TripBundledDayLight]
    /// What the server knowingly left out — "weather", "map" (§14).
    let omits: [String]

    /// Every card's picture (candidate ranking, stage 2): the pool's and
    /// the days'. Kept with the bundle so a card does not go blank at
    /// sea; the galleries are not, they are a thing to browse online.
    var thumbnailURLs: [URL] {
        let pictures = plan.legs.flatMap { leg in
            leg.pool.compactMap(\.image)
                + leg.days.flatMap { $0.blocks.flatMap { $0.stops.compactMap(\.image) } }
        }
        return Array(Set(pictures.compactMap { URL(string: $0.thumbUrl) }))
    }

    /// The light of one day, or nil when the bundle has none for it —
    /// an undated trip, or a day still at trip resolution (§4.3).
    func lightOfDay(legIndex: Int, dayIndex: Int) -> TripDayLight? {
        light.first { $0.legIndex == legIndex && $0.dayIndex == dayIndex }?.light
    }
}

struct TripBundledDayLight: Codable, Sendable {
    let legIndex: Int
    let dayIndex: Int
    let date: String
    let light: TripDayLight
}

/// A bundle plus the moment it was written — the age the screen shows.
struct TripOfflineSnapshot: Sendable {
    let bundle: TripOfflineBundle
    let storedAt: Date
}

/// Whether an error means "no connection" rather than "no".
///
/// The distinction decides whether falling back to the stored plan is
/// honest. A 404 or a 403 is an answer from the server and must reach
/// the traveller as one; a timeout in a foreign train is exactly the
/// case §3.9 was written for and deserves the plan from disk instead
/// of an error message.
enum TripOfflineReach {
    static func meansUnreachable(_ error: Error) -> Bool {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost,
                 .cannotFindHost, .timedOut, .dnsLookupFailed, .dataNotAllowed,
                 .internationalRoamingOff, .callIsActive, .resourceUnavailable,
                 // A ship's or a hotel's Wi-Fi before the login page: it
                 // answers in place of the server, with its own
                 // certificate, a redirect or a page that is not ours.
                 .secureConnectionFailed, .serverCertificateUntrusted,
                 .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot,
                 .serverCertificateNotYetValid, .clientCertificateRejected,
                 .clientCertificateRequired, .appTransportSecurityRequiresSecureConnection,
                 .badServerResponse, .cannotParseResponse, .zeroByteResource,
                 .cannotDecodeRawData, .cannotDecodeContentData,
                 .httpTooManyRedirects, .redirectToNonExistentLocation,
                 .cannotLoadFromNetwork, .backgroundSessionWasDisconnected:
                return true
            default:
                return false
            }
        }
        // A login page that came back with 200: not JSON, and not the
        // server saying anything about the trip.
        if error is DecodingError { return true }
        if let apiError = error as? APIError {
            switch apiError {
            case .invalidResponse:
                return true
            case .httpError(let code, _):
                // A gateway that cannot reach the app is, from here, the
                // same situation as no network: nobody is going to
                // answer. 407 and 511 are a proxy or a captive portal
                // asking for a login before anything gets through.
                return code == 502 || code == 503 || code == 504 || code == 407 || code == 511
            default:
                return false
            }
        }
        return false
    }

    /// Whether the server said the trip is gone for this traveller —
    /// deleted, or no longer shared with them. Only this lets the phone
    /// throw away its copy (the Live Activity, the fences, the offline
    /// plan). Everything else — no network, a captive portal, a server
    /// error, a sign-in that has to be renewed — leaves the copy alone:
    /// it is the one thing that still works when the rest does not.
    static func meansGone(_ error: Error) -> Bool {
        guard let apiError = error as? APIError, case .httpError(let code, _) = apiError else {
            return false
        }
        return code == 403 || code == 404 || code == 410
    }
}

/// Where the bundles live.
///
/// Application Support rather than Caches: the system may empty Caches
/// whenever it likes, and a plan that vanishes because the phone
/// needed space is worse than no offline plan at all — it vanishes
/// precisely when the phone is full of holiday photos.
struct TripOfflineStore: Sendable {
    static let shared = TripOfflineStore()

    private let directory: URL

    init(directory: URL? = nil) {
        if let directory {
            self.directory = directory
        } else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory,
                                                in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSTemporaryDirectory())
            self.directory = base.appendingPathComponent("TripOffline", isDirectory: true)
        }
    }

    private func file(_ planId: Int) -> URL {
        directory.appendingPathComponent("plan-\(planId).json")
    }

    @discardableResult
    func save(_ bundle: TripOfflineBundle, planId: Int) throws -> Date {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(bundle)
        try data.write(to: file(planId), options: .atomic)
        // Excluded from the backup: it is a copy of something the
        // server has, and it can be large.
        var url = file(planId)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
        return storedAt(planId: planId) ?? Date()
    }

    func load(planId: Int) -> TripOfflineSnapshot? {
        let url = file(planId)
        guard let data = try? Data(contentsOf: url),
              let bundle = try? JSONDecoder().decode(TripOfflineBundle.self, from: data)
        else { return nil }
        return TripOfflineSnapshot(bundle: bundle, storedAt: storedAt(planId: planId) ?? Date())
    }

    /// The trip is gone, or no longer ours: its snapshot must not keep
    /// a day running that the server no longer has.
    func forget(planId: Int) {
        try? FileManager.default.removeItem(at: file(planId))
        pruneThumbs()
        pruneDocuments()
    }

    func has(planId: Int) -> Bool {
        FileManager.default.fileExists(atPath: file(planId).path)
    }

    func storedAt(planId: Int) -> Date? {
        let attributes = try? FileManager.default.attributesOfItem(atPath: file(planId).path)
        return attributes?[.modificationDate] as? Date
    }

    /// Roughly how much room it takes, for the screen to say: the plan
    /// and the pictures it brings along.
    func sizeBytes(planId: Int) -> Int? {
        let attributes = try? FileManager.default.attributesOfItem(atPath: file(planId).path)
        guard let plan = (attributes?[.size] as? NSNumber)?.intValue else { return nil }
        let pictures = load(planId: planId)?.bundle.thumbnailURLs.reduce(0) { sum, url in
            let found = try? FileManager.default.attributesOfItem(atPath: thumbFile(url.absoluteString).path)
            return sum + ((found?[.size] as? NSNumber)?.intValue ?? 0)
        } ?? 0
        let papers = (load(planId: planId)?.bundle.documents ?? []).reduce(0) { sum, document in
            let found = try? FileManager.default.attributesOfItem(atPath: documentFile(document.documentId).path)
            return sum + ((found?[.size] as? NSNumber)?.intValue ?? 0)
        }
        return plan + pictures + papers
    }

    /// The plan and the pictures only it needed. A picture another
    /// stored trip shows as well stays.
    func remove(planId: Int) {
        try? FileManager.default.removeItem(at: file(planId))
        pruneThumbs()
        pruneDocuments()
    }

    // MARK: - Pictures

    /// The spot pictures, kept as files beside the plans (§3.9). The
    /// shared URL cache they used to go into is the system's to empty,
    /// and the cards read the app's image cache, not that one — offline
    /// the cards stayed grey.
    private var thumbsDirectory: URL { directory.appendingPathComponent("thumbs", isDirectory: true) }

    private func thumbFile(_ url: String) -> URL {
        thumbsDirectory.appendingPathComponent(TripThumbnailCache.key(url))
    }

    func hasThumb(for url: String) -> Bool {
        FileManager.default.fileExists(atPath: thumbFile(url).path)
    }

    func thumbData(for url: String) -> Data? {
        try? Data(contentsOf: thumbFile(url))
    }

    func saveThumb(_ data: Data, for url: String) {
        try? FileManager.default.createDirectory(at: thumbsDirectory, withIntermediateDirectories: true)
        var target = thumbFile(url)
        try? data.write(to: target, options: .atomic)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? target.setResourceValues(values)
    }

    // MARK: - Documents

    /// The PDFs of the trip's paperwork — only the file, none of the
    /// document module's details (Anton, 16.11.).
    private var documentsDirectory: URL { directory.appendingPathComponent("documents", isDirectory: true) }

    private func documentFile(_ documentId: Int) -> URL {
        documentsDirectory.appendingPathComponent("document-\(documentId).pdf")
    }

    /// The kept file of a document, if it is on the phone.
    func storedDocument(_ documentId: Int) -> URL? {
        let url = documentFile(documentId)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    func saveDocument(_ data: Data, documentId: Int) {
        try? FileManager.default.createDirectory(at: documentsDirectory, withIntermediateDirectories: true)
        var target = documentFile(documentId)
        try? data.write(to: target, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? target.setResourceValues(values)
    }

    /// Drops every document no stored trip lists as readable any more —
    /// also one that somebody took off the trip or may no longer read.
    func pruneDocuments() {
        let wanted = Set(storedPlanIds().flatMap { planId in
            (load(planId: planId)?.bundle.documents ?? []).filter(\.readable).map(\.documentId)
        }.map { "document-\($0).pdf" })
        let names = (try? FileManager.default.contentsOfDirectory(atPath: documentsDirectory.path)) ?? []
        for name in names where !wanted.contains(name) {
            try? FileManager.default.removeItem(at: documentsDirectory.appendingPathComponent(name))
        }
    }

    /// Drops every picture no stored trip shows any more.
    func pruneThumbs() {
        let wanted = Set(storedPlanIds().flatMap { planId in
            (load(planId: planId)?.bundle.thumbnailURLs ?? []).map { TripThumbnailCache.key($0.absoluteString) }
        })
        let names = (try? FileManager.default.contentsOfDirectory(atPath: thumbsDirectory.path)) ?? []
        for name in names where !wanted.contains(name) {
            try? FileManager.default.removeItem(at: thumbsDirectory.appendingPathComponent(name))
        }
    }

    /// The trips that have a bundle here.
    func storedPlanIds() -> Set<Int> {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        return Set(names.compactMap { name -> Int? in
            guard name.hasPrefix("plan-"), name.hasSuffix(".json") else { return nil }
            return Int(name.dropFirst("plan-".count).dropLast(".json".count))
        })
    }

    // MARK: - The list of trips

    private var listFile: URL { directory.appendingPathComponent("plans.json") }

    /// The list as the server last gave it — what the planner shows
    /// when it cannot ask (§3.9). Small, so it is simply kept every time.
    func saveList(_ plans: [TripPlanSummary]) {
        guard let data = try? JSONEncoder().encode(plans) else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? data.write(to: listFile, options: .atomic)
        var url = listFile
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }

    /// The list to show offline, and from when it is. The kept list
    /// when there is one, with any trip stored since added; otherwise
    /// the trips whose bundle is here, so the first flight after an
    /// update is not the one with an empty planner. Nil when there is
    /// neither.
    func keptList() -> (plans: [TripPlanSummary], storedAt: Date)? {
        var plans: [TripPlanSummary] = []
        var storedAt: Date?
        if let data = try? Data(contentsOf: listFile),
           let kept = try? JSONDecoder().decode([TripPlanSummary].self, from: data) {
            plans = kept
            let attributes = try? FileManager.default.attributesOfItem(atPath: listFile.path)
            storedAt = attributes?[.modificationDate] as? Date
        }
        let listed = Set(plans.map(\.id))
        for planId in storedPlanIds().sorted() where !listed.contains(planId) {
            guard let snapshot = load(planId: planId) else { continue }
            plans.append(TripPlanSummary(bundle: snapshot.bundle))
            storedAt = min(storedAt ?? snapshot.storedAt, snapshot.storedAt)
        }
        guard let storedAt, !plans.isEmpty else { return nil }
        return (plans, storedAt)
    }
}

extension TripPlanSummary {
    /// A row for the list from a stored bundle — enough to find the trip
    /// and open it; who organises it is not in the plan, so it is left
    /// open and the row treats it as before.
    init(bundle: TripOfflineBundle) {
        let plan = bundle.plan
        self.init(id: plan.id,
                  title: plan.title,
                  legTitles: plan.legs.map(\.title),
                  dayCount: plan.legs.reduce(0) { $0 + $1.days.count },
                  startDate: plan.legs.first?.startDate,
                  updatedAt: bundle.generatedAt,
                  youOrganise: nil)
    }
}

/// How the offline state reads on screen.
enum TripOfflineWording {
    /// "Stand von heute, 09:14" — the age of what is being shown.
    static func stamp(_ date: Date, now: Date = Date(),
                      locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = timeZone
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        if calendar.isDate(date, inSameDayAs: now) {
            formatter.dateFormat = "HH:mm"
            return "Stand von heute, \(formatter.string(from: date))"
        }
        formatter.dateFormat = "d. MMMM, HH:mm"
        return "Stand vom \(formatter.string(from: date))"
    }

    /// "1,4 MB" — deliberately rough; the number is there to reassure,
    /// not to be budgeted with.
    static func size(_ bytes: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useKB, .useMB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(bytes))
    }
}

/// Loads the bundle's pictures onto the phone, next to the plan
/// (candidate ranking, stage 2). Quietly: a picture that does not come
/// is a card with its symbol, not an error over a plan that is
/// otherwise stored. A picture already there is not fetched again.
enum TripOfflineThumbnails {
    static func prefetch(_ bundle: TripOfflineBundle, into store: TripOfflineStore = .shared) async {
        let missing = bundle.thumbnailURLs.filter { !store.hasThumb(for: $0.absoluteString) }
        await withTaskGroup(of: Void.self) { group in
            for url in missing.prefix(400) {
                group.addTask {
                    guard let fetched = try? await URLSession.shared.data(from: url) else { return }
                    let status = (fetched.1 as? HTTPURLResponse)?.statusCode ?? 200
                    guard status < 300, !fetched.0.isEmpty else { return }
                    store.saveThumb(fetched.0, for: url.absoluteString)
                }
            }
        }
    }
}

/// Loads the files of the trip's readable documents next to the bundle
/// (offline review, F3). Quietly, like the pictures: a file that does
/// not come is a row that opens once there is a network again.
enum TripOfflineDocuments {
    static func fetch(_ bundle: TripOfflineBundle, planId: Int,
                      into store: TripOfflineStore = .shared) async {
        for document in bundle.documents ?? [] where document.readable {
            guard store.storedDocument(document.documentId) == nil,
                  let data = try? await APIClient.shared.downloadData(
                      "/trip-planner/plans/\(planId)/documents/\(document.documentId)/file"),
                  !data.isEmpty
            else { continue }
            store.saveDocument(data, documentId: document.documentId)
        }
        store.pruneDocuments()
    }
}

/// Trips that load themselves for the road (§3.9, Anton 16.11.): one
/// that starts within a week or is running now, on Wi-Fi and with room
/// on the phone — a running trip without any copy also over a metered
/// network. A trip whose bundle somebody deleted by hand stays
/// deleted; the switch in "Unterwegs ohne Netz" turns it all off.
enum TripOfflineAutoLoad {
    static let settingKey = "tripPlanner.offline.autoLoad"
    private static let declinedKey = "tripPlanner.offline.declined"
    /// How far ahead a trip comes along by itself.
    static let daysAhead = 7
    /// A stored bundle older than this is fetched again.
    static let staleAfter: TimeInterval = 6 * 3_600
    /// Room the phone keeps for photos before a plan takes any.
    static let minimumFreeBytes: Int64 = 500_000_000

    static var isOn: Bool {
        UserDefaults.standard.object(forKey: settingKey) as? Bool ?? true
    }

    /// Whether this trip should be (re)loaded now. Pure, for the tests.
    static func wants(_ plan: TripPlanSummary, today: Date, storedAt: Date?,
                      declined: Bool, timeZone: TimeZone = .current) -> Bool {
        guard !declined else { return false }
        switch plan.schedule(on: today, timeZone: timeZone) {
        case .running:
            break
        case .upcoming(let days) where days <= daysAhead:
            break
        default:
            return false
        }
        guard let storedAt else { return true }
        return today.timeIntervalSince(storedAt) > staleAfter
    }

    static func isDeclined(_ planId: Int) -> Bool {
        declined().contains(planId)
    }

    /// Deleted by hand: not loaded again by itself.
    static func decline(_ planId: Int) {
        var ids = declined()
        ids.insert(planId)
        UserDefaults.standard.set(Array(ids), forKey: declinedKey)
    }

    /// Loaded by hand: from now on kept current again.
    static func accept(_ planId: Int) {
        var ids = declined()
        guard ids.remove(planId) != nil else { return }
        UserDefaults.standard.set(Array(ids), forKey: declinedKey)
    }

    private static func declined() -> Set<Int> {
        Set(UserDefaults.standard.array(forKey: declinedKey) as? [Int] ?? [])
    }

    /// Load what the list says should come along. Called with every
    /// list the server gives; does nothing off Wi-Fi or when the switch
    /// is off.
    @MainActor private static var isRunning = false

    @MainActor
    static func run(_ plans: [TripPlanSummary], store: TripOfflineStore = .shared) async {
        // The list and the running-trip check both ask at launch; one
        // download of each trip is enough.
        guard isOn, !isRunning else { return }
        isRunning = true
        defer { isRunning = false }
        let today = Date()
        let due = plans.filter {
            wants($0, today: today, storedAt: store.storedAt(planId: $0.id), declined: isDeclined($0.id))
        }
        guard !due.isEmpty, hasRoom() else { return }
        let network = await currentNetwork()
        for plan in due {
            // Over Wi-Fi everything comes along. Over a metered network
            // only a running trip with no copy at all, and only the plan
            // and its papers: on the first day abroad, on roaming, a plan
            // of a few hundred kilobytes beats none (Anton, 27.11.).
            let urgent = !store.has(planId: plan.id)
                && plan.schedule(on: today).isRunning
            guard network == .unmetered || (network == .metered && urgent) else { continue }
            guard let bundle = try? await TripPlannerViewModel.fetchBundle(planId: plan.id),
                  (try? store.save(bundle, planId: plan.id)) != nil
            else { continue }
            if network == .unmetered {
                await TripOfflineThumbnails.prefetch(bundle, into: store)
            }
            await TripOfflineDocuments.fetch(bundle, planId: plan.id, into: store)
        }
    }

    /// A bundle fetched for another reason — the running day on the Lock
    /// Screen — kept as the copy for the road, when that is wanted. The
    /// pictures follow with the next run over Wi-Fi.
    static func keep(_ bundle: TripOfflineBundle, planId: Int,
                     store: TripOfflineStore = .shared) {
        guard isOn, !isDeclined(planId) else { return }
        try? store.save(bundle, planId: planId)
    }

    private static func hasRoom() -> Bool {
        let home = URL(fileURLWithPath: NSHomeDirectory())
        let values = try? home.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        guard let free = values?.volumeAvailableCapacityForImportantUsage else { return true }
        return free > minimumFreeBytes
    }

    enum Connection { case unmetered, metered, none }

    /// Wi-Fi or another network that is neither metered nor in Low
    /// Data Mode — a whole trip with its pictures is not something to
    /// pull over roaming. Low Data Mode counts as no network: somebody
    /// who turned it on said so.
    private static func currentNetwork() async -> Connection {
        await withCheckedContinuation { continuation in
            let monitor = NWPathMonitor()
            // The handler may be called again before the cancel lands;
            // a continuation resumes once. Both run on the one queue.
            let answered = AnsweredOnce()
            monitor.pathUpdateHandler = { path in
                guard !answered.done else { return }
                answered.done = true
                monitor.cancel()
                let network: Connection
                if path.status != .satisfied || path.isConstrained {
                    network = .none
                } else {
                    network = path.isExpensive ? .metered : .unmetered
                }
                continuation.resume(returning: network)
            }
            monitor.start(queue: DispatchQueue(label: "trip-offline-autoload"))
        }
    }
}

private final class AnsweredOnce: @unchecked Sendable {
    var done = false
}
