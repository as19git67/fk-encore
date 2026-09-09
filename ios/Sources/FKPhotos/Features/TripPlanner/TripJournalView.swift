import SwiftUI

/// Who changed what, and taking it back (§6.3).
///
/// Several devices, some of them offline, change the same trip. The
/// server never overwrites the plan as a whole — it applies small
/// operations and merges them — and this is the other half of that
/// promise: it stays visible who did what, with an undo.
///
/// Two things the screen says out loud rather than hiding. A change
/// that has been taken back is still listed, greyed, because the
/// journal is what happened and a list that loses its mistakes is a
/// list about a trip nobody had. And a change without an exact inverse
/// — a stop put back into the pool, after which the day was re-solved
/// around the gap — shows no undo button at all, with the reason
/// underneath: planning something similar into roughly the same slot
/// would be a new decision wearing the word "rückgängig".
struct TripJournalView: View {
    let planId: Int
    var onPlanChanged: (() -> Void)?

    @State private var entries: [TripJournalEntry] = []
    @State private var isLoading = true
    @State private var busyId: Int?
    @State private var errorMessage: String?

    var body: some View {
        List {
            if isLoading && entries.isEmpty {
                Section { ProgressView() }
            }

            if !isLoading && entries.isEmpty {
                Section {
                    Text("An dieser Reise hat noch niemand etwas geändert.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            if !entries.isEmpty {
                Section {
                    ForEach(entries) { entry in
                        row(for: entry)
                    }
                } header: {
                    Text("Zuletzt geändert")
                } footer: {
                    Text("Rückgängig legt einen neuen Eintrag an, statt einen zu löschen — "
                         + "das Journal ist, was passiert ist.")
                }
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).font(.footnote).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Änderungen")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    @ViewBuilder
    private func row(for entry: TripJournalEntry) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(entry.sentence)
                    .foregroundStyle(entry.undoneAt == nil ? .primary : .secondary)
                    .strikethrough(entry.undoneAt != nil)
                Spacer()
                if busyId == entry.id {
                    ProgressView()
                } else if entry.undoable {
                    Button("Rückgängig") { Task { await undo(entry) } }
                        .font(.caption)
                        .buttonStyle(.borderless)
                }
            }
            Text(entry.byline).font(.footnote).foregroundStyle(.secondary)
            if let note = entry.whyNotUndoable {
                Text(note).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let answer: TripJournal = try await APIClient.shared.get(
                "/trip-planner/plans/\(planId)/ops")
            entries = answer.entries
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func undo(_ entry: TripJournalEntry) async {
        busyId = entry.id
        defer { busyId = nil }
        do {
            let answer: TripJournal = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/ops/undo",
                body: TripUndoRequest(opId: entry.id))
            entries = answer.entries
            onPlanChanged?()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct TripJournal: Codable, Sendable {
    let entries: [TripJournalEntry]
}

struct TripUndoRequest: Encodable, Sendable {
    let opId: Int
}

struct TripJournalEntry: Codable, Identifiable, Sendable {
    let id: Int
    let kind: String
    /// What happened, in one sentence, from the server.
    let sentence: String
    let actor: String?
    let at: String
    /// False when there is no exact inverse — or when it is already undone.
    let undoable: Bool
    let undoneAt: String?
    let undoneBy: String?

    /// "Anna · 12.07.2026" — and who took it back, when somebody did.
    var byline: String {
        var parts = [actor ?? "jemand"]
        if let day = at.split(separator: "T").first {
            parts.append(TripDocumentWording.german(String(day)))
        }
        if let undoneBy { parts.append("zurückgenommen von \(undoneBy)") }
        return parts.joined(separator: " · ")
    }

    /// Why there is no button, for the one operation that has no inverse.
    var whyNotUndoable: String? {
        guard !undoable, undoneAt == nil, kind == "stop-to-pool" else { return nil }
        return "Der Tag wurde danach neu gerechnet — den Spot wieder einzuplanen wäre eine "
            + "neue Entscheidung, keine Rücknahme."
    }
}
