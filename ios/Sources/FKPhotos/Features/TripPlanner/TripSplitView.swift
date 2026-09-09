import SwiftUI

/// Apart for an afternoon, planned together (§6.5).
///
/// A split is an attribute of a block, not a second trip: the block
/// gets two branches, each with its own people, and both end at the
/// same meeting point — whose time is a real fixpoint (§4.4). The
/// budget of each branch follows backwards from that time, so the
/// screen asks for exactly three things: when you meet, who goes where,
/// and what each side is going for.
///
/// The planner's own suggestion sits at the top when the votes pull
/// apart, because that is the moment a split is worth proposing: it is
/// conflict resolution rather than compromise — the cheapest way to
/// give everybody what they wanted, instead of doing both things by
/// halves. Tapping it fills the form in; nothing happens until somebody
/// says so.
struct TripSplitView: View {
    let planId: Int
    let dayIndex: Int
    let blockIndex: Int
    let blockLabel: String
    var onPlanChanged: (() -> Void)?

    @Environment(\.dismiss) private var dismiss

    @State private var suggestion: TripSplitSuggestion?
    @State private var meetAt = "13:00"
    @State private var meetingLabel = ""
    @State private var branches: [TripSplitDraft] = [
        TripSplitDraft(label: ""), TripSplitDraft(label: ""),
    ]
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        List {
            if isLoading {
                Section { ProgressView() }
            }

            if let suggestion {
                Section {
                    Text(suggestion.sentence).font(.footnote)
                    Button("Vorschlag übernehmen") { adopt(suggestion) }
                        .font(.footnote)
                } header: {
                    Text("Die Stimmen sagen")
                }
            }

            Section {
                LabeledContent("Treffen um") {
                    TextField("13:00", text: $meetAt)
                        .multilineTextAlignment(.trailing)
                }
                LabeledContent("Wo") {
                    TextField("Unterkunft", text: $meetingLabel)
                        .multilineTextAlignment(.trailing)
                }
            } header: {
                Text("Treffpunkt")
            } footer: {
                Text("Von dieser Uhrzeit aus wird rückwärts gerechnet: Was jede Seite an Zeit "
                     + "hat, ergibt sich daraus — und nicht aus einer halben Blocklänge.")
            }

            ForEach($branches) { $branch in
                Section {
                    TextField("Wohin geht es?", text: $branch.label)
                    TextField("Spot (OSM-Referenz), optional", text: $branch.osmRef)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text(branch.label.isEmpty ? "Zweig" : branch.label)
                }
            }

            Section {
                Button {
                    Task { await save() }
                } label: {
                    HStack {
                        Text("Trennen")
                        Spacer()
                        if isSaving { ProgressView() }
                    }
                }
                .disabled(isSaving || branches.contains { $0.label.trimmed.isEmpty })
            } footer: {
                Text("Ein Split verbraucht keine Herzenswünsche — er ist keine Bevorzugung, "
                     + "sondern beides gleichzeitig.")
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).font(.footnote).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("\(blockLabel) trennen")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func adopt(_ suggestion: TripSplitSuggestion) {
        branches = [
            TripSplitDraft(label: suggestion.a.name ?? "Erste Gruppe", osmRef: suggestion.a.osmRef),
            TripSplitDraft(label: suggestion.b.name ?? "Zweite Gruppe", osmRef: suggestion.b.osmRef),
        ]
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let answer: TripSplitSuggestionResponse = try await APIClient.shared.get(
                "/trip-planner/plans/\(planId)/splits/suggestion")
            suggestion = answer.suggestion
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        do {
            let _: TripPlanResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/splits",
                body: TripCreateSplitRequest(
                    dayIndex: dayIndex,
                    blockIndex: blockIndex,
                    meetAt: meetAt.trimmed,
                    meetingLabel: meetingLabel.trimmed.isEmpty ? nil : meetingLabel.trimmed,
                    branches: branches.map { draft in
                        TripCreateSplitRequest.Branch(
                            label: draft.label.trimmed,
                            osmRefs: draft.osmRef.trimmed.isEmpty ? nil : [draft.osmRef.trimmed])
                    }))
            onPlanChanged?()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct TripSplitDraft: Identifiable, Sendable {
    let id = UUID()
    var label: String
    var osmRef: String = ""
}

struct TripSplitSuggestionResponse: Codable, Sendable {
    /// Nil when the group agrees — which is most of the time, and then
    /// the planner says nothing at all.
    let suggestion: TripSplitSuggestion?
}

struct TripSplitSuggestion: Codable, Sendable {
    let sentence: String
    let a: TripSplitSide
    let b: TripSplitSide
}

struct TripSplitSide: Codable, Sendable {
    let osmRef: String
    let name: String?
    let voterNames: [String]
}

struct TripCreateSplitRequest: Encodable, Sendable {
    struct Branch: Encodable, Sendable {
        let label: String
        let osmRefs: [String]?
    }

    let dayIndex: Int
    let blockIndex: Int
    let meetAt: String
    let meetingLabel: String?
    let branches: [Branch]
}

/// File-scoped on purpose: a `trimmed` on every String in the app is a
/// bigger claim than this screen needs to make.
private extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
