import Foundation

/// Finding one entry in a collection that has grown (§20.1).
///
/// The collection is sorted into places, which answers "was haben wir
/// hier?" and makes the other question harder: at forty entries in nine
/// groups, "wo war noch mal dieser Biergarten?" means scrolling past
/// eight groups it is not in. So the search runs across every group at
/// once — the one thing a grouped list cannot do by itself.
///
/// **The group's name counts as part of the entry.** Typing "Lissabon"
/// is how somebody asks for everything kept around Lissabon, even
/// though no single entry carries the word: the place a thing is in is
/// how people remember what they kept there.
///
/// Everything a person could have written is searched — what the family
/// calls it and what the map calls it (a renamed entry is still findable
/// under the name on the sign), the note, who kept it, and what kind of
/// place it is.
enum TripIdeaSearch {
    /// Does this entry answer the search?
    ///
    /// `groupName` is what the section is headed with, or nil while the
    /// geocoder has not answered yet — then the entry is matched on its
    /// own fields, which is the honest half of the answer rather than
    /// no answer.
    static func matches(_ idea: TripIdea, groupName: String?, needle: String) -> Bool {
        guard !needle.isEmpty else { return true }
        let fields = [
            idea.displayName,
            idea.name ?? "",
            idea.title ?? "",
            idea.note ?? "",
            idea.addedBy ?? "",
            TripCategory.label(idea.category),
            groupName ?? "",
        ]
        return fields.contains { $0.lowercased().contains(needle) }
    }

    /// The groups as the screen should show them for this search.
    ///
    /// A group whose *name* matches keeps all its entries: the question
    /// "what have we got around Lissabon" is about the place, not about
    /// which of its entries happens to spell it. Groups with nothing
    /// left drop out entirely, so what stays on screen is what was
    /// asked for.
    static func filter(
        _ clusters: [TripIdeaCluster],
        query: String,
        name: (TripIdeaCluster) -> String?,
    ) -> [TripIdeaCluster] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return clusters }
        return clusters.compactMap { cluster in
            let groupName = name(cluster)
            let kept = cluster.ideas.filter {
                matches($0, groupName: groupName, needle: needle)
            }
            guard !kept.isEmpty else { return nil }
            return TripIdeaCluster(id: cluster.id, ideas: kept, centre: cluster.centre)
        }
    }

    /// "3 von 40 Ideen", or nothing to say when everything is shown.
    static func countLabel(shown: Int, of total: Int) -> String? {
        guard shown != total else { return nil }
        return "\(shown) von \(total) Ideen"
    }
}
