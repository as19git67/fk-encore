import Foundation

// MARK: - PhotoFilter

struct PhotoFilter: Equatable {
    enum HiddenMode: String, Equatable {
        case exclude, include, only
    }
    enum MediaType: String, CaseIterable, Equatable {
        case photo, video, raw
        var label: String {
            switch self {
            case .photo: return "Foto"
            case .video: return "Video"
            case .raw:   return "RAW"
            }
        }
    }
    enum TriState: Equatable {
        case any, yes, no
        var label: String {
            switch self {
            case .any: return "Egal"
            case .yes: return "Ja"
            case .no:  return "Nein"
            }
        }
    }

    var favorite: Bool?             = nil
    var hiddenMode: HiddenMode      = .exclude
    var mediaTypes: [MediaType]     = []
    var hasGps: TriState            = .any
    var dateFrom: Date?             = nil
    var dateTo: Date?               = nil

    static let empty = PhotoFilter()

    var isEmpty: Bool { self == .empty }

    var activeCount: Int {
        var n = 0
        if hiddenMode != .exclude { n += 1 }
        if favorite == true { n += 1 }
        if !mediaTypes.isEmpty { n += 1 }
        if hasGps != .any { n += 1 }
        if dateFrom != nil || dateTo != nil { n += 1 }
        return n
    }

    /// Returns query-string pairs to append to API requests.
    func queryParams() -> [String: String] {
        var p: [String: String] = [:]
        if hiddenMode != .exclude { p["hiddenMode"] = hiddenMode.rawValue }
        if favorite == true { p["favorite"] = "true" }
        if !mediaTypes.isEmpty { p["mediaTypes"] = mediaTypes.map(\.rawValue).joined(separator: ",") }
        if hasGps == .yes { p["hasGps"] = "true" }
        if hasGps == .no  { p["hasGps"] = "false" }
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withFullDate]
        if let d = dateFrom { p["dateFrom"] = fmt.string(from: d) }
        if let d = dateTo   { p["dateTo"]   = fmt.string(from: d) }
        return p
    }
}

// MARK: - PhotoSortState

struct PhotoSortState: Equatable {
    enum Field: String, CaseIterable, Equatable {
        case takenAt        = "taken_at"
        case createdAt      = "created_at"
        case size           = "size"
        case qualityScore   = "ai_quality_score"

        var label: String {
            switch self {
            case .takenAt:      return "Aufnahmedatum"
            case .createdAt:    return "Importdatum"
            case .size:         return "Dateigröße"
            case .qualityScore: return "Qualität"
            }
        }
    }

    enum Direction: String, Equatable {
        case asc, desc
        var label: String { self == .asc ? "Aufsteigend" : "Absteigend" }
        var toggled: Direction { self == .asc ? .desc : .asc }
    }

    var field: Field        = .takenAt
    var direction: Direction = .desc

    static let `default` = PhotoSortState()

    var isDefault: Bool { self == .default }

    var label: String {
        "\(field.label) \(direction == .asc ? "↑" : "↓")"
    }

    // Client-side sort comparator for PhotoWithCuration arrays
    func comparator(_ a: PhotoWithCuration, _ b: PhotoWithCuration) -> Bool {
        let aVal = sortValue(for: a)
        let bVal = sortValue(for: b)
        return direction == .desc ? aVal > bVal : aVal < bVal
    }

    private func sortValue(for p: PhotoWithCuration) -> Double {
        let fmt = ISO8601DateFormatter()
        switch field {
        case .takenAt:
            let s = p.taken_at ?? p.created_at
            return fmt.date(from: s ?? "")?.timeIntervalSince1970 ?? 0
        case .createdAt:
            return fmt.date(from: p.created_at)?.timeIntervalSince1970 ?? 0
        case .size:
            return Double(p.size)
        case .qualityScore:
            return p.ai_quality_score ?? 0
        }
    }
}

// MARK: - Client-side filter matching

/// Tests whether a photo matches the given filter locally.
/// Used in Album and Person detail views which load all photos at once.
func matchesFilter(_ photo: PhotoWithCuration, _ filter: PhotoFilter) -> Bool {
    // Hidden mode
    switch filter.hiddenMode {
    case .exclude: if photo.curation_status == .hidden { return false }
    case .only:    if photo.curation_status != .hidden { return false }
    case .include: break
    }

    // Favorite
    if filter.favorite == true && photo.curation_status != .favorite { return false }

    // Media type
    if !filter.mediaTypes.isEmpty {
        let mime = photo.mime_type
        let ok = filter.mediaTypes.contains { mt in
            switch mt {
            case .photo: return mime.hasPrefix("image/") && !mime.hasPrefix("image/x-")
            case .video: return mime.hasPrefix("video/")
            case .raw:   return mime.hasPrefix("image/x-")
            }
        }
        if !ok { return false }
    }

    // GPS
    let hasGps = photo.latitude != nil && photo.longitude != nil
    if filter.hasGps == .yes && !hasGps { return false }
    if filter.hasGps == .no  &&  hasGps { return false }

    // Date range
    if filter.dateFrom != nil || filter.dateTo != nil {
        let isoStr = photo.taken_at ?? photo.created_at
        guard let t = ISO8601DateFormatter().date(from: isoStr) else { return false }
        if let from = filter.dateFrom, t < from { return false }
        if let to = filter.dateTo {
            let end = Calendar.current.date(byAdding: .day, value: 1, to: to) ?? to
            if t >= end { return false }
        }
    }

    return true
}
