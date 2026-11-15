import Foundation

/// What the share sheet handed over, on its way from the extension to
/// the app (§9.2).
///
/// **This file exists twice, byte for byte:**
/// `ios/Sources/FKPhotos/Features/TripPlanner/TripSharePayload.swift` and
/// `ios/F4milShare/TripSharePayload.swift`. The share extension is a
/// separate target that deliberately links no library — it has its own
/// minimal API client for exactly that reason — so neither side can
/// import the other. A comment naming the counterpart is easy to
/// ignore, so `TripSharePayloadCopyTests` compares the two files
/// outright: edit one and the suite goes red until the other matches.
///
/// The handover goes through the App Group's defaults rather than a
/// URL. A share extension cannot reliably open its host app, and it has
/// no business doing the work itself either: picking the trip,
/// resolving names against the regions and confirming a pin on a map is
/// a screenful of decisions, and doing them in an extension would mean
/// building all of it twice, under a memory limit, without the app's
/// API client. So the extension's job is small and robust — capture
/// what was shared, put it down, say so — and the app picks it up.
struct TripSharePayload: Codable, Equatable, Sendable {
    /// The App Group both targets can see.
    static let appGroupID = "group.de.f4mil.photos"
    /// One key holding one JSON payload. A second share overwrites the
    /// first: an inbox that queues would need a way to empty it, and
    /// "the last thing you shared" is what anyone would expect.
    static let defaultsKey = "shared.tripFind"

    /// The link that was shared, if any. A map link, an article.
    var url: String?
    /// Text that was shared or selected — or, later, read out of the
    /// open page on the device (§9.3 stage 1).
    var text: String?
    /// What the page called itself. Only ever shown.
    var title: String?
    /// When it was captured, so a payload nobody collected can be aged
    /// out rather than turning up weeks later as a surprise.
    var capturedAt: Date

    var isEmpty: Bool {
        (url?.isEmpty ?? true) && (text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
    }

    /// How long an uncollected payload stays interesting.
    ///
    /// Long enough to survive "I'll do it tonight", short enough that a
    /// forgotten link does not ambush the next trip.
    static let maximumAge: TimeInterval = 7 * 24 * 60 * 60

    var isStale: Bool { Date().timeIntervalSince(capturedAt) > Self.maximumAge }

    // Encoding and decoding are spelled out rather than left to the
    // synthesised versions, because this crosses a process boundary
    // between two separately built targets: the field names are a wire
    // format, and a rename on one side must not silently become a
    // payload the other side reads as empty.
    enum CodingKeys: String, CodingKey {
        case url
        case text
        case title
        case capturedAt
    }
}

/// Reading the open page (§9.3 stage 1).
///
/// In an extension rather than in the struct's body on purpose: a
/// struct that declares an initialiser inside its own declaration
/// loses the memberwise one, and every other construction of a
/// payload goes through that.
extension TripSharePayload {
    /// What the page-reading script handed back (§9.3 stage 1).
    ///
    /// Safari runs `TripSharePageReading.js` inside the page the reader
    /// is looking at and passes its result through as a property list.
    /// Parsing it here, in the file both targets share, keeps it under
    /// test: the extension itself cannot be unit-tested, and a key
    /// renamed on one side of that boundary would make every share
    /// arrive as a bare link with nobody the wiser.
    ///
    /// A selection wins over the whole page when there is one. Selecting
    /// a paragraph before sharing is a deliberate act and says something
    /// the page cannot: "this cafe", not "the eleven cafes in this
    /// list". Below a few words it is treated as a slip of the finger
    /// rather than an instruction.
    init?(javaScriptResults: [String: Any], capturedAt: Date = Date()) {
        let string = { (key: String) -> String? in
            guard let value = javaScriptResults[key] as? String else { return nil }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }

        let selection = string("selection")
        let page = string("text")
        let chosen = (selection?.count ?? 0) >= Self.minimumSelectionLength ? selection : page

        self.init(url: string("url"), text: chosen, title: string("title"),
                  capturedAt: capturedAt)
        if isEmpty { return nil }
    }

    /// Shorter than this, a "selection" is a stray tap, not a choice.
    static let minimumSelectionLength = 12
}

/// "Something was added from outside" — the extension's note to the app.
///
/// The share sheet writes a find straight into a trip's pool, or an
/// idea straight into the collection, without the app. The app had a
/// trip open the whole time, loaded long before the share, and kept
/// showing the trip as it was until somebody left it and came back.
/// So the extension leaves this note in the App Group, next to the
/// payload above, and the app reads it whenever it comes forward:
/// which trips changed, and whether the collection did.
///
/// A note, not a queue: several shares before the app looks merge into
/// one, and reading it clears it. When the app is already on screen
/// beside the share sheet (iPad, Stage Manager) it never leaves
/// `.active`, so the extension also rings a Darwin notification under
/// `darwinName`; the app listens for it while it runs.
struct TripShareChange: Codable, Equatable, Sendable {
    static let defaultsKey = "shared.tripChanged"
    static let darwinName = "de.f4mil.photos.trip-share-changed"

    /// Trips whose pool the extension wrote to.
    var planIds: [Int] = []
    /// Whether the idea collection got something.
    var ideas = false

    var isEmpty: Bool { planIds.isEmpty && !ideas }

    /// Leave the note: a trip got a find (`planId`), or the collection
    /// an idea (`planId == nil`). Merges with a note nobody read yet.
    static func note(planId: Int?, in store: UserDefaults?) {
        var change = read(store) ?? TripShareChange()
        if let planId {
            if !change.planIds.contains(planId) { change.planIds.append(planId) }
        } else {
            change.ideas = true
        }
        guard let data = try? JSONEncoder().encode(change) else { return }
        store?.set(data, forKey: defaultsKey)
    }

    /// Read the note and clear it. Nil when there is nothing new.
    static func take(from store: UserDefaults?) -> TripShareChange? {
        let change = read(store)
        store?.removeObject(forKey: defaultsKey)
        guard let change, !change.isEmpty else { return nil }
        return change
    }

    private static func read(_ store: UserDefaults?) -> TripShareChange? {
        guard let data = store?.data(forKey: defaultsKey) else { return nil }
        return try? JSONDecoder().decode(TripShareChange.self, from: data)
    }

    /// Tell a running app to read the note now.
    static func ring() {
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(darwinName as CFString), nil, nil, true)
    }
}
