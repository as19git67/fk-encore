import SwiftUI

/// Everybody rates, nobody is averaged away (§6.1).
///
/// The pool is shared and the rating is personal: three answers per
/// spot — *will ich* / *egal* / *lieber nicht* — plus a small number of
/// settings per leg that survive the majority. What the screen shows
/// next to each spot is not a score but the names: a ranking nobody can
/// argue with is one nobody trusts (§3.8).
///
/// Two things it deliberately does not do. Voting does not re-plan —
/// people swipe through thirty spots in a minute, and a plan that
/// rearranged itself under somebody's thumb would be unusable; the
/// button at the top does it once, when somebody asks. And a "lieber
/// nicht" is not a veto: it is a strong minus that enough other people
/// can outvote.
struct TripBallotView: View {
    let planId: Int
    var onPlanChanged: (() -> Void)?

    @State private var ballot: TripBallot?
    @State private var fairness: TripFairness?
    @State private var isLoading = true
    @State private var isApplying = false
    @State private var busyRef: String?
    @State private var errorMessage: String?

    var body: some View {
        List {
            if isLoading && ballot == nil {
                Section { ProgressView() }
            }

            if let ballot {
                Section {
                    Button {
                        Task { await apply() }
                    } label: {
                        HStack {
                            Label("Damit neu planen", systemImage: "arrow.triangle.2.circlepath")
                            Spacer()
                            if isApplying { ProgressView() }
                        }
                    }
                    .disabled(isApplying)
                } footer: {
                    Text("Abstimmen ändert den Plan nicht von selbst — sonst wäre er nach "
                         + "jedem Wisch ein anderer.")
                }

                if let sentence = fairness?.sentence {
                    Section {
                        Text(sentence).font(.footnote)
                    } header: {
                        Text("Fairness")
                    }
                }

                if !ballot.silent.isEmpty {
                    Section {
                        Text("Noch nichts gesagt haben: \(ballot.silent.joined(separator: ", "))")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                Section {
                    ForEach(ballot.entries) { entry in
                        row(for: entry, heartsLeft: ballot.heartsLeft)
                    }
                } header: {
                    Text("\(ballot.entries.count) Vorschläge · "
                         + "\(ballot.heartsLeft) von \(ballot.heartQuota) Herzenswünschen frei")
                } footer: {
                    Text("Ein Herzenswunsch kommt in den Plan, solange er zeitlich möglich ist "
                         + "— unabhängig von der Mehrheit.")
                }
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).font(.footnote).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Abstimmen")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    @ViewBuilder
    private func row(for entry: TripBallotEntry, heartsLeft: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(entry.label)
                if entry.planned {
                    Text("im Plan")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if busyRef == entry.osmRef { ProgressView() }
            }
            if let voices = entry.voices {
                Text(voices).font(.footnote).foregroundStyle(.secondary)
            }
            HStack(spacing: 8) {
                ForEach(TripVote.allCases, id: \.rawValue) { vote in
                    Button {
                        Task { await cast(entry, vote, heart: false) }
                    } label: {
                        Label(vote.label, systemImage: vote.symbolName)
                            .font(.caption)
                            .labelStyle(.iconOnly)
                            .padding(6)
                            .background(entry.myVote == vote.rawValue && !entry.myHeart
                                        ? Color.accentColor.opacity(0.2)
                                        : Color.clear)
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(.borderless)
                }
                Button {
                    Task { await cast(entry, .want, heart: !entry.myHeart) }
                } label: {
                    Image(systemName: entry.myHeart ? "heart.fill" : "heart")
                        .font(.caption)
                        .foregroundStyle(entry.myHeart ? .pink : .secondary)
                        .padding(6)
                }
                .buttonStyle(.borderless)
                .disabled(!entry.myHeart && heartsLeft == 0)
            }
        }
        .padding(.vertical, 2)
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            ballot = try await APIClient.shared.get("/trip-planner/plans/\(planId)/votes")
            fairness = try await APIClient.shared.get("/trip-planner/plans/\(planId)/fairness")
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func cast(_ entry: TripBallotEntry, _ vote: TripVote, heart: Bool) async {
        busyRef = entry.osmRef
        defer { busyRef = nil }
        do {
            let _: TripCastVoteResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/votes",
                body: TripCastVoteRequest(osmRef: entry.osmRef, value: vote.rawValue, heart: heart))
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func apply() async {
        isApplying = true
        defer { isApplying = false }
        do {
            let _: TripPlanResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/votes/apply", body: TripEmptyBody())
            await load()
            onPlanChanged?()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

enum TripVote: String, CaseIterable, Sendable {
    case want
    case meh
    case ratherNot = "rather-not"

    var label: String {
        switch self {
        case .want: return "Will ich"
        case .meh: return "Egal"
        case .ratherNot: return "Lieber nicht"
        }
    }

    var symbolName: String {
        switch self {
        case .want: return "hand.thumbsup"
        case .meh: return "minus.circle"
        case .ratherNot: return "hand.thumbsdown"
        }
    }
}

struct TripBallot: Codable, Sendable {
    let legIndex: Int
    let entries: [TripBallotEntry]
    /// Settings left for me on this leg (§6.1).
    let heartsLeft: Int
    let heartQuota: Int
    /// Who has not said anything at all yet.
    let silent: [String]
}

struct TripBallotEntry: Codable, Identifiable, Sendable {
    var id: String { osmRef }
    let osmRef: String
    let name: String?
    /// What to put on the row — the name where the map has one, else
    /// what it does know ("Kirche (ohne Namen)"). Never the reference:
    /// nobody can vote on `way:213850482`.
    let label: String
    let category: String
    let myVote: String?
    let myHeart: Bool
    let wants: [String]
    let ratherNots: [String]
    let hearts: [String]
    let planned: Bool

    /// Who said what, in names rather than a number: an average is what
    /// this whole chapter exists to avoid (§6.1).
    var voices: String? {
        var parts: [String] = []
        if !hearts.isEmpty { parts.append("Herzenswunsch: \(hearts.joined(separator: ", "))") }
        if !wants.isEmpty { parts.append("will: \(wants.joined(separator: ", "))") }
        if !ratherNots.isEmpty {
            parts.append("lieber nicht: \(ratherNots.joined(separator: ", "))")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

struct TripFairness: Codable, Sendable {
    let rows: [TripFairnessRow]
    /// The account in one sentence, or nil when there is nothing to say.
    let sentence: String?
}

struct TripFairnessRow: Codable, Identifiable, Sendable {
    var id: String { voter }
    let voter: String
    let name: String
    let granted: Int
    let deferred: Int
}

struct TripCastVoteRequest: Encodable, Sendable {
    let osmRef: String
    let value: String
    let heart: Bool
}

struct TripCastVoteResponse: Codable, Sendable {
    let osmRef: String
    let value: String
    let heart: Bool
    let heartsLeft: Int
}

struct TripEmptyBody: Encodable, Sendable {}
