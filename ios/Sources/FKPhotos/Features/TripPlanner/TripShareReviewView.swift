import SwiftUI

/// "Das haben wir gefunden" — confirming a shared find into the pool
/// (§9.2).
///
/// One row per proposal, and each row says what it still needs. The
/// three states look similar and are not: a resolved place needs a tap,
/// an ambiguous name needs you to pick which one, and a place
/// OpenStreetMap has never heard of needs a duration — because nothing
/// else can supply one and the planner will not invent it (§15.3).
struct TripShareReviewView: View {
    @State private var model: TripShareReviewViewModel
    @Environment(\.dismiss) private var dismiss
    /// Set to true the first time a proposal reaches the pool, so the caller
    /// knows not to discard the inbox entry on dismiss.
    @Binding var didAddAnything: Bool
    @State private var confirmLeaving = false

    init(planId: Int, payload: TripSharePayload,
         userTitle: String = "", userNote: String = "",
         didAddAnything: Binding<Bool>) {
        _model = State(initialValue: TripShareReviewViewModel(
            planId: planId, payload: payload, userTitle: userTitle, userNote: userNote))
        _didAddAnything = didAddAnything
    }

    var body: some View {
        Group {
            if model.isAnalysing {
                ProgressView("Wird gelesen…")
            } else if let response = model.response {
                list(response)
            } else if let errorMessage = model.errorMessage {
                // Not a dead end: the find is still in the inbox, and
                // the analysis can be asked for again.
                ContentUnavailableView {
                    Label("Nicht gelesen", systemImage: "link.badge.plus")
                } description: {
                    Text(errorMessage + "\n\nDer Fund bleibt gespeichert.")
                } actions: {
                    Button("Nochmal versuchen") { Task { await model.analyse() } }
                        .buttonStyle(.borderedProminent)
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Gefunden")
        .navigationBarTitleDisplayMode(.inline)
        .plannerErrorBanner(model.response == nil ? nil : model.errorMessage,
                            dismiss: { model.errorMessage = nil })
        .toolbar {
            if model.readyCount > 1 {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Alle übernehmen") { Task { await model.addAllReady() } }
                        .disabled(model.addingId != nil)
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Fertig") {
                    // "Fertig" with nothing taken over used to close
                    // silently; whoever tapped it expected the places
                    // to be in the pool.
                    if model.readyCount > 0 { confirmLeaving = true } else { dismiss() }
                }
            }
        }
        .confirmationDialog("Noch nichts übernommen", isPresented: $confirmLeaving,
                            titleVisibility: .visible) {
            Button(model.readyCount == 1 ? "Übernehmen und schließen" : "Alle übernehmen und schließen") {
                Task {
                    await model.addAllReady()
                    if model.errorMessage == nil { dismiss() }
                }
            }
            Button("Ohne Übernahme schließen", role: .destructive) { dismiss() }
            Button("Abbrechen", role: .cancel) {}
        } message: {
            Text(model.readyCount == 1
                 ? "Ein Ort ist bereit, aber noch nicht bei den Kandidaten."
                 : "\(model.readyCount) Orte sind bereit, aber noch nicht bei den Kandidaten.")
        }
        .task { await model.analyse() }
        .onChange(of: model.added.count) { _, count in
            if count > 0 { didAddAnything = true }
        }
    }

    private func list(_ response: TripAnalyseShareResponse) -> some View {
        Form {
            if let source = model.sourceUrl {
                Section("Quelle") {
                    Text(source).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                }
            }

            if response.proposals.isEmpty {
                Section {
                    Text("Auf dieser Seite war kein Ort zu finden.")
                        .foregroundStyle(.secondary)
                }
            }

            ForEach(response.proposals) { proposal in
                Section {
                    row(proposal)
                } header: {
                    Text(proposal.name ?? "Ohne Namen")
                } footer: {
                    footer(proposal)
                }
            }

            // Everything the server refused. Shown rather than dropped:
            // an extraction that quietly halves is worse than one that
            // says what it left out (§8.3).
            if !response.rejected.isEmpty {
                Section("Nicht übernommen") {
                    ForEach(response.rejected, id: \.self) { note in
                        Text(note).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }

        }
    }

    @ViewBuilder
    private func row(_ proposal: TripShareProposal) -> some View {
        if let quote = proposal.quote {
            Text("„\(quote)“")
                .font(.footnote)
                .italic()
                .foregroundStyle(.secondary)
        }

        switch proposal.missing {
        case .nothing:
            EmptyView()
        case .whichPlace:
            Picker("Welcher?", selection: Binding(
                get: { model.chosenOption[proposal.id] },
                set: { model.chosenOption[proposal.id] = $0 },
            )) {
                Text("Bitte wählen").tag(TripShareProposal.Option?.none)
                ForEach(proposal.options) { option in
                    Text(optionLabel(option)).tag(TripShareProposal.Option?.some(option))
                }
            }
        case .howLong:
            TripDurationPicker(minutes: Binding(
                get: { model.dwellMinutes[proposal.id] ?? TripShareReviewViewModel.suggestedDwellMinutes },
                set: { model.dwellMinutes[proposal.id] = $0 },
            ))
        }

        if let outcome = model.added[proposal.id] {
            Label(outcome, systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .font(.footnote)
        } else if proposal.isAddable {
            Button {
                Task { await model.add(proposal) }
            } label: {
                if model.addingId == proposal.id {
                    HStack { ProgressView(); Text("Wird übernommen…") }
                } else {
                    Label("Zu den Kandidaten", systemImage: "plus.circle")
                }
            }
            .disabled(!model.isReady(proposal))
        }
    }

    @ViewBuilder
    private func footer(_ proposal: TripShareProposal) -> some View {
        switch proposal.kind {
        case .unique:
            Text("In OpenStreetMap gefunden — Öffnungszeiten und Dauer kommen von dort.")
        case .coordinate:
            Text("Aus dem Karten-Link. Kein OpenStreetMap-Eintrag dazu, also fehlen "
                 + "Öffnungszeiten und Kategorie.")
        case .ambiguous:
            Text("Mehrere Orte heißen so. Welcher gemeint ist, kann nur jemand wissen, der da war.")
        case .none:
            if proposal.isAddable {
                Text("Kein OpenStreetMap-Eintrag — Öffnungszeiten und Kategorie bleiben unbekannt.")
            } else {
                // Not a failure. It stays visible with its quote until
                // somebody resolves it by hand (§10.4).
                Text("Kein Ort dazu gefunden. Bleibt als Notiz, bis jemand ihn von Hand zuordnet.")
            }
        }
    }

    private func optionLabel(_ option: TripShareProposal.Option) -> String {
        // Never the reference: nobody chooses between two cafés by
        // `way:213850482`.
        let name = option.name ?? "Ort ohne Namen"
        guard let distance = option.distanceM else { return name }
        return distance >= 1_000
            ? "\(name) — \(String(format: "%.1f", distance / 1_000)) km"
            : "\(name) — \(Int(distance.rounded())) m"
    }
}
