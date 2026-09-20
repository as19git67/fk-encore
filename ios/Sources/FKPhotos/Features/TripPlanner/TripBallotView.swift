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
    /// Which leg is being voted on. The ballot used to default to the
    /// first one, so on a trip with several cities the Osaka day
    /// offered Tokyo's spots — and the vote landed on Tokyo.
    let legIndex: Int
    /// The leg itself, already loaded by the screen that opened this
    /// one. Every spot on the ballot is one of its stops or one of its
    /// pool entries, so the row can say what and where without the
    /// ballot carrying a second copy of both.
    let leg: TripLeg?
    var onPlanChanged: (() -> Void)?

    @State private var ballot: TripBallot?
    @State private var fairness: TripFairness?
    @State private var isLoading = true
    @State private var isApplying = false
    @State private var busyRef: String?
    @State private var errorMessage: String?
    @State private var query = ""

    /// Somebody is looking for one spot rather than working through the
    /// whole list. Whitespace is trimmed here as well as in the filter:
    /// a field holding one space is not a search.
    private var isSearching: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// What the leg knows about a spot. The row shows it and the search
    /// reads the same thing, so both are about one place.
    private func details(for entry: TripBallotEntry) -> TripBallotDetails.Details? {
        leg.map { TripBallotDetails.of(entry.osmRef, in: $0) }
    }

    /// The rows the search leaves. Computed outside the body rather
    /// than bound inside it: a `let` in a result builder is one of the
    /// things that reads fine and compiles differently.
    private var visibleEntries: [TripBallotEntry] {
        TripBallotSearch.filter(ballot?.entries ?? [], query: query) { details(for: $0) }
    }

    var body: some View {
        List {
            if isLoading && ballot == nil {
                Section { ProgressView() }
            }

            if let ballot {
                // The three sections above the list are about the
                // ballot as a whole — re-planning the leg, the fairness
                // account, who has not said anything yet. While
                // somebody is searching, the screen is about one spot,
                // and they would push the row that was asked for off
                // the top.
                if !isSearching {
                    Section {
                        Button {
                            Task { await apply() }
                        } label: {
                            HStack {
                                Label("Damit neu planen",
                                      systemImage: "arrow.triangle.2.circlepath")
                                Spacer()
                                if isApplying { ProgressView() }
                            }
                        }
                        .disabled(isApplying)
                    } footer: {
                        Text("Wünsche ändern den Plan nicht von selbst — sonst wäre er nach "
                             + "jedem Wisch ein anderer.")
                    }
                }

                if !isSearching, let sentence = fairness?.sentence {
                    Section {
                        Text(sentence).font(.footnote)
                    } header: {
                        Text("Fairness")
                    }
                }

                if !isSearching, !ballot.silent.isEmpty {
                    Section {
                        Text("Noch nichts gesagt haben: \(ballot.silent.joined(separator: ", "))")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                Section {
                    ForEach(visibleEntries) { entry in
                        row(for: entry, heartsLeft: ballot.heartsLeft)
                    }
                } header: {
                    // How much of the ballot the search left, said in
                    // the header it would otherwise contradict: a list
                    // that says "30 Vorschläge" and shows two reads as
                    // a ballot that lost something.
                    if let count = TripBallotSearch.countLabel(
                        shown: visibleEntries.count, of: ballot.entries.count) {
                        Text(count)
                    } else {
                        Text("\(ballot.entries.count) Vorschläge · "
                             + "\(ballot.heartsLeft) von \(ballot.heartQuota) "
                             + "Herzenswünschen frei")
                    }
                } footer: {
                    Text("Ein Herzenswunsch kommt in den Plan, solange er zeitlich möglich ist "
                         + "— unabhängig von der Mehrheit.")
                }
            }

        }
        // An overlay rather than a row: inside the list the empty state
        // gets a row's width and squeezes itself into a column of
        // single letters.
        .overlay {
            if let ballot, isSearching, visibleEntries.isEmpty, !ballot.entries.isEmpty {
                ContentUnavailableView.search(text: query)
                    .background(Color(uiColor: .systemGroupedBackground))
            }
        }
        .navigationTitle("Wünsche")
        // Always on screen rather than hidden above the first row: a
        // field you have to know about to pull down is a field most
        // people never find. Everything the row says is searched —
        // including who wanted what, which is the question a ballot is
        // the only screen able to answer.
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always),
                    prompt: "Vorschläge, Orte und Namen durchsuchen")
        .plannerErrorBanner(errorMessage, retry: { await load() }, dismiss: { errorMessage = nil })
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    // No `@ViewBuilder` here any more: the row reads what the plan
    // knows about the spot before it builds anything, and a result
    // builder cannot hold a `let` and an explicit `return`. It returns
    // one stack, so the attribute was never earning its place.
    private func row(for entry: TripBallotEntry, heartsLeft: Int) -> some View {
        let details = leg.map { TripBallotDetails.of(entry.osmRef, in: $0) }
        return VStack(alignment: .leading, spacing: 6) {
            // The name first, and with the width to be read: a long
            // one („Église Saint-Nicolas-des-Champs") was sharing the
            // line with a badge and an icon, and SwiftUI answered by
            // giving each its share — the title wrapped into a narrow
            // column and broke mid-word. The priority says which of
            // the three the reader came for.
            HStack(alignment: .firstTextBaseline) {
                Text(entry.label)
                    .fixedSize(horizontal: false, vertical: true)
                    .layoutPriority(1)
                Spacer(minLength: 8)
                // Everything the plan knows about the place, one tap
                // away: voting on a name is voting on a word (§3.8).
                if let spot = details?.spot, let leg {
                    NavigationLink {
                        TripSpotDetailView(
                            spot: spot,
                            mode: leg.transportMode,
                            onSave: nil,
                        ) { _ in EmptyView() }
                    } label: {
                        Image(systemName: "info.circle")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("\(entry.label) — Details")
                }
                if busyRef == entry.osmRef { ProgressView() }
            }
            // What it is and where it is — the two questions somebody
            // needs answered before they can mean their vote.
            //
            // For a spot that is on a day this line ends in „Tag 1,
            // Vormittag", which is „im Plan" with the day in it. The
            // badge that used to sit beside the name said the same
            // thing less precisely, and cost the name the width it
            // needed. It stays only for the case the line cannot
            // cover: a vote about a spot the leg no longer has.
            if let line = details?.line, !line.isEmpty {
                Label(line, systemImage: TripCategory.symbol(entry.category))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if entry.planned {
                Text("im Plan")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let note = details?.note {
                Text(note).font(.caption).italic().foregroundStyle(.secondary)
            }
            if let voices = entry.voices {
                Text(voices).font(.footnote).foregroundStyle(.secondary)
            }
            // Three answers with their words on them, not three glyphs
            // 28 points wide; the heart on its own line, because it is
            // a different thing from a vote and it has a quota.
            Picker("Wunsch", selection: Binding(
                get: { entry.myVote },
                set: { chosen in
                    guard let chosen, let vote = TripVote(rawValue: chosen) else { return }
                    Task { await cast(entry, vote, heart: false) }
                },
            )) {
                ForEach(TripVote.allCases, id: \.rawValue) { vote in
                    Text(vote.label).tag(Optional(vote.rawValue))
                }
            }
            .pickerStyle(.segmented)
            .disabled(busyRef == entry.osmRef)
            HStack(spacing: 8) {
                Button {
                    Task { await cast(entry, .want, heart: !entry.myHeart) }
                } label: {
                    Label(entry.myHeart ? "Herzenswunsch" : "Zum Herzenswunsch machen",
                          systemImage: entry.myHeart ? "heart.fill" : "heart")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(entry.myHeart ? .pink : .accentColor)
                .disabled(!entry.myHeart && heartsLeft == 0)
                if !entry.myHeart && heartsLeft == 0 {
                    Text("Keine Herzenswünsche mehr frei")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            try await loadVotes()
            fairness = try await APIClient.shared.get("/trip-planner/plans/\(planId)/fairness")
            errorMessage = nil
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    /// The ballot alone. After a vote only this changes; the fairness
    /// account is worth a second round trip on apply and on pull, not
    /// thirty times a minute while somebody swipes through the list.
    private func loadVotes() async throws {
        ballot = try await APIClient.shared.get(
            "/trip-planner/plans/\(planId)/votes",
            query: ["legIndex": String(legIndex)],
        )
    }

    private func cast(_ entry: TripBallotEntry, _ vote: TripVote, heart: Bool) async {
        busyRef = entry.osmRef
        defer { busyRef = nil }
        do {
            let _: TripCastVoteResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/votes",
                body: TripCastVoteRequest(
                    legIndex: legIndex,
                    osmRef: entry.osmRef,
                    value: vote.rawValue,
                    heart: heart,
                ))
            try await loadVotes()
            errorMessage = nil
        } catch {
            errorMessage = TripErrorText.describe(error)
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
            errorMessage = TripErrorText.describe(error)
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
    /// Which leg the spot belongs to. Left out, the server assumed the
    /// first one — so on a trip with several cities a vote cast in
    /// Osaka was recorded against Tokyo.
    let legIndex: Int
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
