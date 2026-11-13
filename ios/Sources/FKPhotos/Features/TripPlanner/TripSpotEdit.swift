import SwiftUI

/// What a person wants to say about one spot (§9.2, §10.4), edited in
/// place on the detail screen (Anton, 13.11.: no separate edit sheet).
///
/// Three fields, and keeping them apart is the point. The **title** is
/// the group's own handle for the place — "das Museum mit dem
/// Dachgarten" — and never a correction of OpenStreetMap, whose name
/// stays visible underneath it. The **note** is why it matters:
/// "Eingang um die Ecke", "Tickets vorher kaufen". The **URL** is the
/// one link they keep with it.
///
/// A value rather than three `@State` strings in the view, so the
/// rules about what an empty field means can be tested without a view.
struct TripSpotEdit: Identifiable, Equatable, Sendable {
    let osmRef: String
    var title: String
    var note: String
    var url: String
    var dwellMinutes: Int
    /// "We come here for the light" (§7.3) — the one thing that lets
    /// the sun weigh in on where this spot lands.
    var photoStop: Bool

    var id: String { osmRef }

    init(osmRef: String, title: String = "", note: String = "", url: String = "",
         dwellMinutes: Int = 45, photoStop: Bool = false) {
        self.osmRef = osmRef
        self.title = title
        self.note = note
        self.url = url
        self.dwellMinutes = dwellMinutes
        self.photoStop = photoStop
    }

    /// What the fields start with: the spot's own title if the group
    /// gave it one, never the map's name pre-filled into the field.
    /// Offering "Museum Beispiel" as an editable value would turn every
    /// save into a rename nobody asked for.
    init(_ spot: TripSpotDetail) {
        self.init(
            osmRef: spot.osmRef,
            title: spot.title ?? "",
            note: spot.note ?? "",
            url: spot.sourceUrl ?? "",
            dwellMinutes: spot.dwellMinutes,
            photoStop: spot.photoStop,
        )
    }

    /// Whether the link is one the app could open.
    ///
    /// The server refuses anything but http and https; saying so here
    /// saves a round trip and, more to the point, says it next to the
    /// field rather than as a red banner over the whole screen.
    var urlIsUsable: Bool {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return true }
        guard let parsed = URL(string: trimmed), let scheme = parsed.scheme?.lowercased() else {
            return false
        }
        return (scheme == "http" || scheme == "https") && parsed.host?.isEmpty == false
    }

    /// Trimmed, with an empty field meaning "clear this one" rather
    /// than "leave it alone" — the server draws the same line.
    var trimmed: TripSpotEdit {
        TripSpotEdit(
            osmRef: osmRef,
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            note: note.trimmingCharacters(in: .whitespacesAndNewlines),
            url: url.trimmingCharacters(in: .whitespacesAndNewlines),
            dwellMinutes: dwellMinutes,
            // Carried through on purpose: dropping it here reset the
            // switch on every save, so "Fotostopp" could be turned on
            // but never kept.
            photoStop: photoStop,
        )
    }

    /// Whether this is worth sending: something changed against what
    /// the spot says now, and the link is one the server takes. Asked
    /// each time a field is left, so leaving one unchanged sends nothing.
    func needsSaving(against base: TripSpotEdit) -> Bool {
        let mine = trimmed
        return mine != base.trimmed && mine.urlIsUsable
    }

    /// The stays to offer in the menu, with the current one kept even
    /// if it is not one of them, so the menu shows what is set.
    static func dwellChoices(current: Int) -> [Int] {
        let presets = [15, 30, 45, 60, 90, 120, 180, 240, 360, 480]
        return presets.contains(current) ? presets : (presets + [current]).sorted()
    }
}
