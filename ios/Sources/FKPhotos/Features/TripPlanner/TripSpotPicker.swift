import Foundation

/// What the spot picker shows (reise-planen-und-unterwegs.md, stage 4),
/// kept apart from the view so the order can be tested.
///
/// One row for every way a place reaches the picker — an idea of the
/// stay, a highlight, a name or category search, a pasted map link —
/// so the rows look and act alike whatever they came from.
struct TripPickerItem: Identifiable, Sendable {
    enum Source: Sendable {
        case idea(TripCandidate)
        case highlight(TripHighlight)
        case place(TripSearchedPlace)
    }

    let source: Source
    /// Its place in the highlights by fame, for the size of its circle
    /// on the map; nil for anything that is not a highlight.
    var rank: Int? = nil

    var id: String { osmRef }

    var osmRef: String {
        switch source {
        case .idea(let c): c.osmRef
        case .highlight(let h): h.osmRef
        case .place(let p): p.osmRef
        }
    }

    var title: String {
        switch source {
        case .idea(let c): c.displayName
        case .highlight(let h): h.name ?? h.localName ?? TripCategory.unnamed(h.category)
        case .place(let p): p.name ?? TripCategory.unnamed(p.categories.first ?? "")
        }
    }

    var localName: String? {
        switch source {
        case .idea(let c): c.localName
        case .highlight(let h): h.name == nil ? nil : h.localName
        case .place: nil
        }
    }

    /// One line under the name: why somebody wanted it, else what it is.
    var line: String? {
        switch source {
        case .idea(let c): c.note ?? c.description?.text ?? c.reasons.first
        case .highlight(let h): h.reason ?? h.description?.text
        case .place(let p): p.distanceLabel.map { "\($0) von der Unterkunft" }
        }
    }

    var picture: TripRoutePhoto? {
        switch source {
        case .idea(let c): c.image
        case .highlight(let h): h.picture
        case .place: nil
        }
    }

    var dwellMinutes: Int? {
        switch source {
        case .idea(let c): c.dwellMinutes
        case .highlight(let h): h.dwellMinutes
        case .place(let p): p.dwellMinutes
        }
    }

    var openingHours: String? {
        switch source {
        case .idea(let c): c.openingHours
        case .highlight(let h): h.openingHours
        case .place(let p): p.openingHours
        }
    }

    var coordinate: TripCoordinate {
        switch source {
        case .idea(let c): c.coordinate
        case .highlight(let h): TripCoordinate(lat: h.lat, lon: h.lon)
        case .place(let p): TripCoordinate(lat: p.lat, lon: p.lon)
        }
    }

    /// Already one of the stay's ideas.
    var isIdea: Bool {
        switch source {
        case .idea: true
        case .highlight(let h): h.inPool
        case .place(let p): p.inPool
        }
    }

    var isPlanned: Bool {
        switch source {
        case .idea: false
        case .highlight(let h): h.planned
        case .place(let p): p.planned
        }
    }

    var category: String? {
        switch source {
        case .idea(let c): c.category
        case .highlight(let h): h.category
        case .place(let p): p.categories.first
        }
    }

    /// What `POST …/suggest-day` needs to know about it.
    var suggestSpot: TripSuggestSpot {
        TripSuggestSpot(osmRef: osmRef, dwellMinutes: dwellMinutes, openingHours: openingHours, category: category)
    }

    /// The same place as the name search adds it.
    func searched(legIndex: Int) -> TripSearchedPlace? {
        switch source {
        case .idea: nil
        case .highlight(let h): h.asSearched(legIndex: legIndex)
        case .place(let p): p
        }
    }

    var detail: TripSpotDetail {
        switch source {
        case .idea(let c): TripSpotDetail(c)
        case .highlight(let h): TripSpotDetail(h)
        case .place(let p): TripSpotDetail(p)
        }
    }
}

/// The chips over the picker's list.
enum TripPickerChip: String, CaseIterable, Identifiable, Sendable {
    case all, ideas, highlights, trips, routes, food, more

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: "Alles"
        case .ideas: "Ideen"
        case .highlights: "Highlights"
        case .trips: "Ausflüge"
        case .routes: "Strecken"
        case .food: "Essen"
        case .more: "Mehr"
        }
    }
}

enum TripSpotPicker {
    /// The rows in order: without a query the stay's own ideas first,
    /// then the highlights by fame; with one, the ideas whose name
    /// matches and then what the search found. A place that is already
    /// an idea is listed once, as the idea.
    static func items(
        chip: TripPickerChip,
        query: String,
        ideas: [TripCandidate],
        highlights: [TripHighlight],
        results: [TripSearchedPlace],
        link: TripSearchedPlace? = nil,
    ) -> [TripPickerItem] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let ideaRows = ideas
            .filter { text.isEmpty || link != nil || matches($0, text) }
            .map { TripPickerItem(source: .idea($0)) }
        let taken = Set(ideas.map(\.osmRef))
        let highlightRows = highlights.enumerated()
            .filter { !taken.contains($0.element.osmRef) }
            .map { TripPickerItem(source: .highlight($0.element), rank: $0.offset) }
        let resultRows = results
            .filter { !taken.contains($0.osmRef) }
            .map { TripPickerItem(source: .place($0)) }
        let linkRows = link.map { [TripPickerItem(source: .place($0))] } ?? []

        switch chip {
        case .ideas:
            return ideaRows
        case .highlights:
            return text.isEmpty ? highlightRows : resultRows
        case .more:
            return resultRows
        case .food, .trips, .routes:
            return []
        case .all:
            if link != nil { return linkRows }
            return text.isEmpty ? ideaRows + highlightRows : ideaRows + resultRows
        }
    }

    /// A pasted map link as the row it adds; nil for ordinary text.
    static func linkPlace(_ query: String, legIndex: Int) -> TripSearchedPlace? {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.contains("://") || text.hasPrefix("maps:"),
              let place = TripMapLink.place(from: text)
        else { return nil }
        return TripSearchedPlace(
            osmRef: "link:\(place.lat),\(place.lon)", name: place.name ?? "Ort aus dem Link",
            lat: place.lat, lon: place.lon, distanceM: nil, categories: [], legIndex: legIndex,
            openingHours: nil, phone: nil, website: nil, dwellMinutes: nil, inPool: false, planned: false,
        )
    }

    /// "+ Tag 2", or "Zur Reise" while no day is known.
    static func addLabel(_ suggestion: TripDaySuggestion?) -> String {
        guard let day = suggestion?.dayIndex else { return "Zur Reise" }
        return "+ Tag \(day + 1)"
    }

    /// The block a place goes into on a day of the stay.
    static func spotsBlock(of day: TripDay) -> TripBlock? {
        day.blocks.first { $0.kind == "spots" } ?? day.blocks.first
    }

    /// The day food goes to: the first with an hour left, else the first.
    static func foodDay(_ days: [TripDay]) -> TripDay? {
        let sorted = days.sorted { $0.dayIndex < $1.dayIndex }
        return sorted.first { ($0.freeMinutes ?? Int.max) >= 60 } ?? sorted.first
    }

    /// A highlight's circle on the map: the best known three largest,
    /// the next seven medium, the rest small.
    static func markerSize(rank: Int?) -> Double {
        guard let rank else { return 18 }
        if rank < 3 { return 34 }
        if rank < 10 { return 26 }
        return 18
    }

    /// Half the visible map's diagonal span, in metres, as the search radius.
    static func radiusM(latitudeDelta: Double, longitudeDelta: Double, latitude: Double) -> Double {
        let metresPerDegree = 111_000.0
        let height = latitudeDelta * metresPerDegree
        let width = longitudeDelta * metresPerDegree * cos(latitude * .pi / 180)
        return max(height, width) / 2
    }

    private static func matches(_ candidate: TripCandidate, _ text: String) -> Bool {
        [candidate.title, candidate.name, candidate.localName]
            .compactMap { $0 }
            .contains { $0.localizedCaseInsensitiveContains(text) }
    }
}

extension TripSpotDetail {
    /// A highlight before it is anybody's idea: no title, no note.
    init(_ highlight: TripHighlight) {
        osmRef = highlight.osmRef
        name = highlight.name
        title = nil
        localName = highlight.localName
        wikipediaUrl = highlight.wikipediaUrl
        category = highlight.category
        coordinate = TripCoordinate(lat: highlight.lat, lon: highlight.lon)
        dwellMinutes = highlight.dwellMinutes
        reasons = highlight.reason.map { [$0] } ?? []
        note = nil
        sourceUrl = nil
        unmatched = false
        photoStop = false
        supportsPhotoStop = false
        extent = nil
        image = highlight.picture
        description = highlight.description
    }

    /// A search result: what OpenStreetMap knows and nothing more.
    init(_ place: TripSearchedPlace) {
        osmRef = place.osmRef
        name = place.name
        title = nil
        localName = nil
        wikipediaUrl = nil
        category = place.categories.first ?? ""
        coordinate = TripCoordinate(lat: place.lat, lon: place.lon)
        dwellMinutes = place.dwellMinutes ?? 45
        reasons = []
        note = nil
        sourceUrl = place.website
        unmatched = place.osmRef.hasPrefix("link:")
        photoStop = false
        supportsPhotoStop = false
        extent = nil
        image = nil
        description = nil
    }
}
