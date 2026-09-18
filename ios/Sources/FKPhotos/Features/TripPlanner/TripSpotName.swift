import Foundation

/// Putting a place's two names on one line (§10.4).
///
/// The server decides *which* name a traveller can read: in Rome that
/// is "Kolosseum" and not `Colosseo`, in Tokyo "Nationalmuseum Tokio"
/// and not 東京国立博物館. The other one is not thrown away, because it
/// is the one written on the building, printed on the ticket and
/// understood at the counter — the name to plan with and the name to
/// stand in front of a door with are genuinely two different things.
///
/// Where a screen has room for two lines it shows them as two (the spot
/// details say „Vor Ort“, the map sheet puts it under the title). This
/// is for the rows that have one line and one name's worth of space:
/// there the local name goes in brackets behind the readable one, which
/// is how a guidebook writes it and short enough not to cost the row
/// its name.
enum TripSpotName {

    /// "Kolosseum (Colosseo)", or just the name when there is nothing
    /// to put beside it.
    ///
    /// The local name is dropped when it is missing, blank, or the same
    /// string again: printing one name twice reads like two places, and
    /// the server already leaves `localName` empty in that case — this
    /// checks anyway, because a row that says "Marienplatz
    /// (Marienplatz)" is the kind of thing nobody reports and everybody
    /// notices.
    static func line(_ display: String, local: String?) -> String {
        guard let local = local?.trimmingCharacters(in: .whitespacesAndNewlines),
              !local.isEmpty,
              local.caseInsensitiveCompare(display) != .orderedSame else {
            return display
        }
        return "\(display) (\(local))"
    }
}
