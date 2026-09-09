import Foundation

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
    let light: [TripBundledDayLight]
    /// What the server knowingly left out — "weather", "map" (§14).
    let omits: [String]

    /// The light of one day, or nil when the bundle has none for it —
    /// an undated trip, or a day still at trip resolution (§4.3).
    func light(legIndex: Int, dayIndex: Int) -> TripDayLight? {
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
                 .internationalRoamingOff, .callIsActive, .resourceUnavailable:
                return true
            default:
                return false
            }
        }
        if let apiError = error as? APIError, case .httpError(let code, _) = apiError {
            // A gateway that cannot reach the app is, from here, the
            // same situation as no network: nobody is going to answer.
            return code == 502 || code == 503 || code == 504
        }
        return false
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
        return storedAt(planId) ?? Date()
    }

    func load(planId: Int) -> TripOfflineSnapshot? {
        let url = file(planId)
        guard let data = try? Data(contentsOf: url),
              let bundle = try? JSONDecoder().decode(TripOfflineBundle.self, from: data)
        else { return nil }
        return TripOfflineSnapshot(bundle: bundle, storedAt: storedAt(planId) ?? Date())
    }

    func has(planId: Int) -> Bool {
        FileManager.default.fileExists(atPath: file(planId).path)
    }

    func storedAt(planId: Int) -> Date? {
        let attributes = try? FileManager.default.attributesOfItem(atPath: file(planId).path)
        return attributes?[.modificationDate] as? Date
    }

    /// Roughly how much room it takes, for the screen to say.
    func sizeBytes(planId: Int) -> Int? {
        let attributes = try? FileManager.default.attributesOfItem(atPath: file(planId).path)
        return (attributes?[.size] as? NSNumber)?.intValue
    }

    func remove(planId: Int) {
        try? FileManager.default.removeItem(at: file(planId))
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
