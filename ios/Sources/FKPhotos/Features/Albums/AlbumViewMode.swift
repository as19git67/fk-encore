import Foundation

/// The album "views" from `docs/album-photo-views.md`: a lens over a shared
/// album that combines a hide filter and a favorites filter so every
/// participant can look at *their* version of the album without the group
/// having to agree on one cut (issue #760).
///
/// ## Why this is evaluated on the device
///
/// The backend can apply the very same presets server-side (`active_view` on
/// `album_user_settings`), but the web app deliberately stopped using that:
/// `AlbumDetailView.vue` resets `active_view` to `"all"` on load and narrows
/// the full album client-side instead. Persisting a preset from iOS would
/// therefore be silently undone the next time the album is opened in a
/// browser. So iOS mirrors the web and filters locally — switching a view
/// costs no round trip, and the two clients cannot fight over the setting.
///
/// ## One deviation worth knowing
///
/// Because the server still runs its default `hideFilter: "mine"`, photos the
/// *current user* hid never reach the device. In `consensus` the backend
/// preset would instead keep them and judge purely by `hide_count`. In
/// practice that only hides photos you personally rejected, which is what a
/// user expects from every other view — so the difference is accepted rather
/// than worked around.
enum AlbumViewMode: String, CaseIterable, Identifiable, Codable, Sendable {
    /// Everything the server returned (it already dropped what I hid).
    case all
    /// Only what I favorited.
    case favorites
    /// "Gruppen-Highlights": what several participants like and nobody hid.
    case consensus
    /// Favorited by someone else, but not by me — the "what did I miss?" lens.
    case othersFavorites = "others-favorites"
    /// Consensus with user-tunable thresholds (see `AlbumViewConfig`).
    case custom

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all:             return "Alle Fotos"
        case .favorites:       return "Meine Favoriten"
        case .consensus:       return "Gruppen-Highlights"
        case .othersFavorites: return "Von anderen favorisiert"
        case .custom:          return "Eigene Ansicht"
        }
    }

    var systemImage: String {
        switch self {
        case .all:             return "square.grid.2x2"
        case .favorites:       return "heart"
        case .consensus:       return "person.2.badge.gearshape"
        case .othersFavorites: return "person.2"
        case .custom:          return "slider.horizontal.3"
        }
    }

    /// Modes that read the anonymized counters and are therefore meaningless
    /// (and hidden) on an album with a single participant — mirrors the web,
    /// where "Gruppen-Highlights" only appears for shared albums.
    var requiresSharedAlbum: Bool {
        switch self {
        case .all, .favorites:                    return false
        case .consensus, .othersFavorites, .custom: return true
        }
    }

    /// The modes offered for an album, in menu order.
    static func available(isShared: Bool) -> [AlbumViewMode] {
        allCases.filter { isShared || !$0.requiresSharedAlbum }
    }
}

/// Thresholds behind `AlbumViewMode.custom`. Defaults reproduce the backend's
/// `consensus` preset (`favConsensusMin: 2`, `hideConsensusMin: 1` — i.e. drop
/// anything with one or more hides), which makes "Eigene Ansicht" a starting
/// point the user can loosen or tighten rather than a blank slate.
struct AlbumViewConfig: Equatable, Codable, Sendable {
    /// Minimum number of participants who must have favorited a photo.
    var favMin: Int = 2
    /// Maximum number of hides a photo may carry and still be shown.
    var hideMax: Int = 0

    static let `default` = AlbumViewConfig()

    /// Clamped to the participant count so the steppers can never be dragged
    /// into a state that filters everything away by construction.
    func clamped(memberCount: Int) -> AlbumViewConfig {
        let upper = max(1, memberCount)
        return AlbumViewConfig(
            favMin: min(max(0, favMin), upper),
            hideMax: min(max(0, hideMax), upper)
        )
    }
}

/// Pure decision logic for the album view modes — no SwiftUI, so the semantics
/// can be locked down by tests (`AlbumViewModeTests`).
struct AlbumViewFilter: Equatable, Sendable {
    var mode: AlbumViewMode = .all
    var config: AlbumViewConfig = .default

    init(mode: AlbumViewMode = .all, config: AlbumViewConfig = .default) {
        self.mode = mode
        self.config = config
    }

    /// Whether one photo survives the active view.
    ///
    /// `stats` is nil for albums the server considers unshared; the counter
    /// based modes then have nothing to judge by and let everything pass
    /// rather than silently emptying the grid.
    func matches(curation: CurationStatus, stats: PhotoCurationStats?) -> Bool {
        switch mode {
        case .all:
            return true

        case .favorites:
            return curation == .favorite

        case .consensus:
            guard let stats else { return true }
            return stats.favCount >= 2 && stats.hideCount == 0

        case .othersFavorites:
            guard let stats else { return true }
            // Favorited by at least one participant, but not by me. My own
            // vote is part of `fav_count`, so "somebody else" means the
            // counter must carry a vote that isn't mine.
            guard curation != .favorite else { return false }
            return stats.favCount >= 1

        case .custom:
            guard let stats else { return true }
            return stats.favCount >= config.favMin && stats.hideCount <= config.hideMax
        }
    }

    /// Short description of the active thresholds, shown under the mode name
    /// so "Eigene Ansicht" isn't opaque in the toolbar menu.
    var summary: String? {
        switch mode {
        case .all, .favorites, .consensus, .othersFavorites:
            return nil
        case .custom:
            let fav = config.favMin == 1 ? "1 Favorit" : "\(config.favMin) Favoriten"
            let hide = config.hideMax == 0
                ? "keine Ausblendung"
                : "max. \(config.hideMax) Ausblendungen"
            return "ab \(fav), \(hide)"
        }
    }
}

extension PhotoCurationStats {
    /// The counters after the current user changed their *own* vote. The
    /// signed-in user is one of the participants the server counted, so a
    /// favorite tap has to move the badge immediately — otherwise "3/5" sits
    /// there stale until the next album load.
    func applying(vote old: CurationStatus, to new: CurationStatus) -> PhotoCurationStats {
        guard old != new else { return self }
        var fav = favCount
        var hide = hideCount
        if old == .favorite { fav -= 1 }
        if old == .hidden   { hide -= 1 }
        if new == .favorite { fav += 1 }
        if new == .hidden   { hide += 1 }
        return PhotoCurationStats(
            fav_count: max(0, fav),
            hide_count: max(0, hide),
            member_count: member_count
        )
    }
}

/// Per-album persistence of the chosen view. Deliberately local to the device:
/// the server-side `active_view` is owned by the web app (see the type comment
/// on `AlbumViewMode`), so iOS keeps its lens to itself instead of racing it.
enum AlbumViewModeStore {
    private static let prefix = "albumViewFilter."

    static func key(albumId: Int) -> String { "\(prefix)\(albumId)" }

    static func load(albumId: Int, defaults: UserDefaults = .standard) -> AlbumViewFilter {
        guard let data = defaults.data(forKey: key(albumId: albumId)),
              let stored = try? JSONDecoder().decode(Stored.self, from: data) else {
            return AlbumViewFilter()
        }
        return AlbumViewFilter(mode: stored.mode, config: stored.config)
    }

    static func save(_ filter: AlbumViewFilter, albumId: Int, defaults: UserDefaults = .standard) {
        // "Alle Fotos" is the default — drop the entry instead of persisting a
        // no-op so a reset really clears the stored state.
        guard filter.mode != .all else {
            defaults.removeObject(forKey: key(albumId: albumId))
            return
        }
        guard let data = try? JSONEncoder().encode(Stored(mode: filter.mode, config: filter.config)) else { return }
        defaults.set(data, forKey: key(albumId: albumId))
    }

    private struct Stored: Codable {
        let mode: AlbumViewMode
        let config: AlbumViewConfig
    }
}
