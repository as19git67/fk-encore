import Foundation

// MARK: - Orientation variants (portrait + landscape of one motif)
//
// Of one motif there is often a portrait and a landscape frame, a few seconds
// apart. The server derives a *format group* from the similarity groups
// (.claude/plans/orientierungs-varianten.md) and ships both sides on
// `GET /photos/groups`; every list shows only the side that fits the screen
// and keeps the other one a tap — or a turn of the device — away. Nothing is
// hidden: the rules here only decide what is on screen right now.

extension PhotoOrientation {
    /// Whether a photo of this shape fits the screen as it is held. A square
    /// fits either way; a photo of unknown shape is not told otherwise.
    func fits(_ screen: ScreenOrientation) -> Bool {
        switch (self, screen) {
        case (.square, _), (.unknown, _): return true
        case (.portrait, .portrait), (.landscape, .landscape): return true
        default: return false
        }
    }

    /// Portrait or landscape: the shapes that can have another side.
    var isSided: Bool { self == .portrait || self == .landscape }
}

/// The two sides of a format group: how many visible members each has and
/// which photos they are, best-ranked first.
struct OrientationVariants: Codable, Sendable, Equatable {
    let portrait: Int
    let landscape: Int
    let portrait_ids: [Int]
    let landscape_ids: [Int]

    /// Which side `photoId` sits on, or nil when it is not part of the format
    /// group (a square or unmeasured member of the same similarity group).
    func side(of photoId: Int) -> PhotoOrientation? {
        if portrait_ids.contains(photoId) { return .portrait }
        if landscape_ids.contains(photoId) { return .landscape }
        return nil
    }

    /// The photos on the other side of `photoId`, best-ranked first. Empty
    /// when `photoId` has no other side.
    func counterpartIds(of photoId: Int) -> [Int] {
        switch side(of: photoId) {
        case .portrait: return landscape_ids
        case .landscape: return portrait_ids
        default: return []
        }
    }
}

/// Which side of a format group a list asks the server for.
enum VariantMode: String, Sendable, Equatable {
    case all
    case portrait
    case landscape

    /// The mode for the screen as it is held. `all` while the user asked to
    /// see the variants or is selecting: whoever selects, shares or hides
    /// must see everything, so no action ever hits a photo that is not on
    /// screen.
    static func forScreen(
        _ screen: ScreenOrientation,
        showVariants: Bool,
        selecting: Bool
    ) -> VariantMode {
        if showVariants || selecting { return .all }
        switch screen {
        case .portrait: return .portrait
        case .landscape: return .landscape
        }
    }
}

enum OrientationVariantRules {

    /// The format groups by member photo id, from the groups the server lists.
    /// Only groups that currently form a format group carry `variants`, so the
    /// map holds exactly the photos that have another side.
    static func byPhotoId(groups: [AlbumGroupReview.Group]) -> [Int: OrientationVariants] {
        var out: [Int: OrientationVariants] = [:]
        for group in groups {
            guard let variants = group.variants else { continue }
            for id in variants.portrait_ids + variants.landscape_ids {
                out[id] = variants
            }
        }
        return out
    }

    /// Whether a viewer that shows `shown` should switch to the other side
    /// because the screen turned. Never against a side the user pinned by
    /// choosing it, never without a counterpart, and only when the shown side
    /// does not fit the screen while the other one does.
    static func shouldSwitchSide(
        shown: PhotoOrientation?,
        counterpart: PhotoOrientation?,
        screen: ScreenOrientation,
        pinned: Bool
    ) -> Bool {
        if pinned { return false }
        guard let shown, let counterpart, shown.isSided, counterpart.isSided else { return false }
        return !shown.fits(screen) && counterpart.fits(screen)
    }

    /// German name of the side a photo of this shape belongs to, for the
    /// button that switches to it.
    static func label(for orientation: PhotoOrientation?) -> String {
        switch orientation {
        case .portrait: return "Hochformat"
        case .landscape: return "Querformat"
        default: return "Andere Seite"
        }
    }
}

/// The slideshow's share of the rule: take the fitting side first, then pair
/// what is left (`SlideshowPlanner`). Pure, so it is testable without images.
enum SlideshowVariants {

    /// The counterpart ids a slideshow over `photos` may need, each once.
    static func counterpartIds(
        photos: [PhotoWithCuration],
        variants: [Int: OrientationVariants]
    ) -> [Int] {
        var seen: Set<Int> = []
        var out: [Int] = []
        for photo in photos {
            for id in (variants[photo.id]?.counterpartIds(of: photo.id) ?? []) where !seen.contains(id) {
                seen.insert(id)
                out.append(id)
            }
        }
        return out
    }

    /// Drop the photos that are the other side of a photo earlier in the
    /// list. A list that holds both sides (the grid in "Formatvarianten
    /// anzeigen") would otherwise show the same motif twice in a row.
    static func dropCounterparts(
        photos: [PhotoWithCuration],
        variants: [Int: OrientationVariants]
    ) -> [PhotoWithCuration] {
        var suppressed: Set<Int> = []
        var out: [PhotoWithCuration] = []
        for photo in photos {
            if suppressed.contains(photo.id) { continue }
            out.append(photo)
            for id in (variants[photo.id]?.counterpartIds(of: photo.id) ?? []) {
                suppressed.insert(id)
            }
        }
        return out
    }

    /// Replace every photo that does not fit the screen by the best-ranked
    /// counterpart that does, where one has been fetched. Positions stay the
    /// same, so slides already planned keep their indices.
    static func substitute(
        photos: [PhotoWithCuration],
        counterparts: [Int: PhotoWithCuration],
        variants: [Int: OrientationVariants],
        screen: ScreenOrientation
    ) -> [PhotoWithCuration] {
        photos.map { photo in
            guard let orientation = photo.orientation, !orientation.fits(screen),
                  let ids = variants[photo.id]?.counterpartIds(of: photo.id) else { return photo }
            for id in ids {
                if let other = counterparts[id], let o = other.orientation, o.fits(screen) {
                    return other
                }
            }
            return photo
        }
    }
}
