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

    init(planId: Int, payload: TripSharePayload) {
        _model = State(initialValue: TripShareReviewViewModel(planId: planId, payload: payload))
    }

    var body: some View {
        Group {
            if model.isAnalysing {
                ProgressView("Wird gelesen…")
            } else if let response = model.response {
                list(response)
            } else if let errorMessage = model.errorMessage {
                ContentUnavailableView("Nicht gelesen", systemImage: "link.badge.plus",
                                       description: Text(errorMessage))
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Gefunden")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Fertig") { dismiss() }
            }
        }
        .task { await model.analyse() }
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

            if let errorMessage = model.errorMessage {
                Section {
                    Text(errorMessage).font(.footnote).foregroundStyle(.red)
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
            Stepper(value: Binding(
                get: { model.dwellMinutes[proposal.id] ?? TripShareReviewViewModel.suggestedDwellMinutes },
                set: { model.dwellMinutes[proposal.id] = $0 },
            ), in: 10...480, step: 15) {
                let minutes = model.dwellMinutes[proposal.id]
                    ?? TripShareReviewViewModel.suggestedDwellMinutes
                Text("Aufenthalt: \(minutes) Min.")
            }
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
                    Label("In den Vorrat", systemImage: "plus.circle")
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
        guard let distance = option.distanceM else { return option.name ?? option.osmRef }
        let name = option.name ?? option.osmRef
        return distance >= 1_000
            ? "\(name) — \(String(format: "%.1f", distance / 1_000)) km"
            : "\(name) — \(Int(distance.rounded())) m"
    }
}
