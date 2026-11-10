import SwiftUI

/// The vote over a stay's ideas (§6.1), for the spot picker
/// (reise-planen-und-unterwegs.md, stage 7, step 5). It used to live in
/// the candidates list; with that list gone the picker carries the ring
/// on each idea and the answers among the idea's actions. Off unless
/// the trip votes at all (ideas plan, stage 7).
@Observable @MainActor
final class TripStayBallot {
    let planId: Int
    let legIndex: Int
    private(set) var ballot: TripBallot?
    /// The spot a vote is on its way for.
    private(set) var votingRef: String?
    var errorMessage: String?

    init(planId: Int, legIndex: Int) {
        self.planId = planId
        self.legIndex = legIndex
    }

    func entry(_ osmRef: String) -> TripBallotEntry? {
        ballot?.entries.first { $0.osmRef == osmRef }
    }

    func load() async {
        do {
            ballot = try await APIClient.shared.get(
                "/trip-planner/plans/\(planId)/votes",
                query: ["legIndex": String(legIndex)],
            )
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    func cast(_ osmRef: String, _ vote: TripVote, heart: Bool) async {
        votingRef = osmRef
        defer { votingRef = nil }
        do {
            let _: TripCastVoteResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/votes",
                body: TripCastVoteRequest(legIndex: legIndex, osmRef: osmRef, value: vote.rawValue, heart: heart),
            )
            await load()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    /// Will ich, egal, lieber nicht, and the heart: one list for the
    /// ring, the long press and the details.
    func actions(_ entry: TripBallotEntry) -> [TripPinSheetAction] {
        var actions = TripVote.allCases.map { vote in
            TripPinSheetAction(
                id: "vote-\(vote.rawValue)",
                title: vote.label,
                systemImage: entry.myVote == vote.rawValue && !entry.myHeart ? "checkmark" : vote.symbolName,
                closes: false,
                group: .vote,
            ) { [weak self] in
                await self?.cast(entry.osmRef, vote, heart: false)
            }
        }
        let heartsLeft = ballot?.heartsLeft ?? 0
        if entry.myHeart || heartsLeft > 0 {
            actions.append(TripPinSheetAction(
                id: "heart",
                title: entry.myHeart ? "Kein Herzenswunsch mehr" : "Zum Herzenswunsch machen",
                systemImage: entry.myHeart ? "heart.slash" : "heart",
                footer: entry.myHeart ? nil : "Noch \(heartsLeft) frei.",
                closes: false,
                group: .vote,
            ) { [weak self] in
                await self?.cast(entry.osmRef, .want, heart: !entry.myHeart)
            })
        }
        return actions
    }
}

/// The vote as a ring: its colour and symbol say what I answered, a
/// tap offers the answers (§6.1). The same ring the map draws.
struct TripVoteRing: View {
    let ballot: TripStayBallot
    let entry: TripBallotEntry

    var body: some View {
        let kind = TripBallotPinKind.of(entry)
        Menu {
            TripSpotActionMenuItems(actions: ballot.actions(entry))
        } label: {
            ZStack {
                Circle()
                    .stroke(kind.colour, lineWidth: 2.5)
                    .frame(width: 30, height: 30)
                if ballot.votingRef == entry.osmRef {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: kind.symbolName)
                        .font(.caption)
                        .foregroundStyle(kind.colour)
                }
            }
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .disabled(ballot.votingRef != nil)
        .accessibilityLabel("Dein Wunsch: \(kind.label)")
    }
}
