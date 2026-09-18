import Foundation

/// Finding one spot on a ballot that has grown (§6.1, §20.1).
///
/// A leg's pool is thirty or forty entries by the time everybody has
/// thrown theirs in, and the ballot is one long list of them. That is
/// right for the first pass — people swipe through it and answer — and
/// wrong for the second: „wie hatte ich noch mal für das Museum
/// gestimmt?" means scrolling past everything else to find one row.
///
/// So the same search the collection has (§20.1), on the same terms:
/// everything the row already says is searchable, because what somebody
/// remembers about a spot is rarely its name. They remember that it was
/// a museum, that it lies on Tag 2, that somebody wrote something next
/// to it — or **who** wanted it. The voter names count: „was will
/// eigentlich Alex?" is a question about the vote, and the ballot is
/// the only screen that can answer it.
///
/// Nothing here filters *votes* — a search that hid rows by how they
/// were voted on would be a ranking by the back door, which is what
/// §6.1 exists to avoid.
enum TripBallotSearch {

    /// Does this row answer the search?
    ///
    /// `details` is what the leg knows about the spot — the same thing
    /// the row shows underneath the name. It is nil when the ballot
    /// names something the leg no longer has; then the entry is matched
    /// on its own fields, which is the honest half of the answer rather
    /// than no answer.
    static func matches(
        _ entry: TripBallotEntry,
        details: TripBallotDetails.Details?,
        needle: String,
    ) -> Bool {
        guard !needle.isEmpty else { return true }
        var fields = [
            entry.label,
            entry.name ?? "",
            TripCategory.label(entry.category),
            details?.line ?? "",
            details?.note ?? "",
            // The name on the building, for a spot whose row shows a
            // German or English one (§10.4): standing in front of it,
            // the local name is the one somebody has just read.
            details?.spot?.localName ?? "",
        ]
        fields.append(contentsOf: entry.hearts)
        fields.append(contentsOf: entry.wants)
        fields.append(contentsOf: entry.ratherNots)
        return fields.contains { $0.lowercased().contains(needle) }
    }

    /// The ballot as the screen should show it for this search.
    ///
    /// The order is the ballot's own — a search narrows the list, it
    /// does not re-sort it, so a row keeps the neighbours it had.
    static func filter(
        _ entries: [TripBallotEntry],
        query: String,
        details: (TripBallotEntry) -> TripBallotDetails.Details?,
    ) -> [TripBallotEntry] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return entries }
        return entries.filter { matches($0, details: details($0), needle: needle) }
    }

    /// "3 von 40 Vorschlägen", or nothing to say when everything is shown.
    static func countLabel(shown: Int, of total: Int) -> String? {
        guard shown != total else { return nil }
        return "\(shown) von \(total) Vorschlägen"
    }
}
