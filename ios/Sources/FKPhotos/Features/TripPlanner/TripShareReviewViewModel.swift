import SwiftUI

/// Turning what was shared into pool entries (§9.2).
///
/// Two calls, and the split between them is the point. The server
/// *analyses* — reads the link or the article, resolves the names it
/// can against the trip's regions — and answers proposals. Adding is a
/// separate call to the endpoint that already holds the five rules of
/// §9.2, so the right leg, the merging of duplicates and the keeping of
/// provenance are decided in one place rather than two.
///
/// Nothing is added without a yes. The concept asks for one gesture,
/// and this is that gesture: for a resolved place a tap, and for the
/// two cases that genuinely cannot be resolved without you — which of
/// three cafés, and how long a place nobody has data for takes — the
/// question, once.
@Observable @MainActor
final class TripShareReviewViewModel {
    private(set) var isAnalysing = false
    private(set) var response: TripAnalyseShareResponse?
    /// Which proposal is being added, so its row can say so.
    private(set) var addingId: String?
    /// Proposals that made it into the pool, and what happened to them.
    private(set) var added: [String: String] = [:]
    var errorMessage: String?

    /// The choice made for an ambiguous proposal, keyed by proposal id.
    var chosenOption: [String: TripShareProposal.Option] = [:]
    /// The duration given for a proposal with no OSM entry behind it.
    var dwellMinutes: [String: Int] = [:]

    /// The default offered for "wie lange?".
    ///
    /// A number the traveller can accept or change, not a number the
    /// planner made up: it is on screen, and it only ever reaches the
    /// server because somebody left it there.
    static let suggestedDwellMinutes = 45

    let planId: Int
    private let payload: TripSharePayload

    init(planId: Int, payload: TripSharePayload) {
        self.planId = planId
        self.payload = payload
    }

    var sourceUrl: String? { response?.sourceUrl ?? payload.url }

    func analyse() async {
        isAnalysing = true
        defer { isAnalysing = false }
        struct Body: Encodable {
            let url: String?
            let text: String?
        }
        do {
            let result: TripAnalyseShareResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/shares",
                body: Body(url: payload.url, text: payload.text),
            )
            response = result
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Is this one ready to be added, given what has been answered?
    func isReady(_ proposal: TripShareProposal) -> Bool {
        guard proposal.isAddable, added[proposal.id] == nil else { return false }
        switch proposal.missing {
        case .nothing: return true
        case .whichPlace: return chosenOption[proposal.id] != nil
        case .howLong: return (dwellMinutes[proposal.id] ?? 0) > 0
        }
    }

    /// Add one proposal to the pool.
    func add(_ proposal: TripShareProposal) async {
        guard let request = requestFor(proposal) else { return }
        addingId = proposal.id
        defer { addingId = nil }
        do {
            let result: TripAddFindResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/finds",
                body: request,
            )
            // "Zum Vorrat" and "mit einem vorhandenen Eintrag
            // zusammengeführt" are different things, and the traveller
            // should see which happened (§9.2, rule 3).
            markAdded(proposal.id, outcome: result.merged
                ? "mit einem vorhandenen Eintrag zusammengeführt"
                : "im Vorrat")
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Record that one proposal reached the pool, and how.
    ///
    /// Named rather than assigned inline because it is the transition
    /// that takes a row out of the list of things still to do.
    func markAdded(_ proposalId: String, outcome: String) {
        added[proposalId] = outcome
    }

    /// Build the find request, or nil when something is still missing.
    ///
    /// Internal rather than private so it can be tested: what reaches
    /// the pool — which coordinate, which leg, and whether a duration
    /// is sent at all — is the part that goes quietly wrong.
    func requestFor(_ proposal: TripShareProposal) -> TripAddFindRequest? {
        let chosen = chosenOption[proposal.id]
        let position: TripShareProposal.Coordinate? = chosen
            .map { .init(lat: $0.lat, lon: $0.lon) } ?? proposal.position
        guard let position else { return nil }

        // A resolved place brings its own duration from OSM; sending
        // one anyway would override real data with a default.
        let needsDuration = chosen == nil && proposal.missing == .howLong
        let dwell = dwellMinutes[proposal.id]
        if needsDuration && (dwell ?? 0) <= 0 { return nil }

        return TripAddFindRequest(
            lat: position.lat,
            lon: position.lon,
            name: chosen?.name ?? proposal.name,
            note: noteFor(proposal),
            sourceUrl: sourceUrl,
            legIndex: chosen?.legIndex ?? proposal.legIndex,
            dwellMinutes: needsDuration ? dwell : nil,
        )
    }

    /// Why this was saved, which the concept says matters more than the
    /// name when the day is being planned (§9.2, rule 4).
    ///
    /// The article's own words where there are any: "beste Pastéis laut
    /// Blog" is the sentence worth keeping, and it is in the quote.
    func noteFor(_ proposal: TripShareProposal) -> String? {
        var parts: [String] = []
        if let quote = proposal.quote, !quote.isEmpty { parts.append("„\(quote)“") }
        if let hint = proposal.placeHint, !hint.isEmpty { parts.append(hint) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
