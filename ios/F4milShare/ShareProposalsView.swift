import SwiftUI

/// Confirm one or more proposals into the trip pool (§9.2).
///
/// The proposals come either from the server's analysis of a URL/page, or
/// from a synthetic single-proposal response built from an Apple Maps link
/// that already carried coordinates. In both cases the user sees what was
/// found and taps "In den Vorrat" per proposal.
struct ShareProposalsView: View {
    let response: ShareAnalyzeResponse
    let planId: Int
    let userTitle: String
    let userNote: String
    let onClose: () -> Void

    private static let defaultDwellMinutes = 45

    @State private var dwellMinutes: [String: Int] = [:]
    @State private var chosenOption: [String: ShareProposal.Option] = [:]
    @State private var addedOutcome: [String: String] = [:]
    @State private var addingId: String?
    @State private var errorMessage: String?

    var body: some View {
        Form {
            if let source = response.sourceUrl {
                Section("Quelle") {
                    Text(source).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                }
            }

            if response.proposals.isEmpty {
                Section {
                    Label("Auf dieser Seite war kein Ort zu finden.",
                          systemImage: "mappin.slash")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }

            ForEach(response.proposals) { proposal in
                Section {
                    proposalRow(proposal)
                } header: {
                    Text(proposalHeadline(proposal))
                } footer: {
                    Text(proposalHint(proposal))
                        .font(.footnote)
                }
            }

            if !response.rejected.isEmpty {
                Section("Nicht \u{00FC}bernommen") {
                    ForEach(response.rejected, id: \.self) { note in
                        Text(note).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }

            if let error = errorMessage {
                Section {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Gefunden")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Fertig") { onClose() }
            }
        }
    }

    // MARK: - Row builder

    @ViewBuilder
    private func proposalRow(_ proposal: ShareProposal) -> some View {
        if let quote = proposal.quote, !quote.isEmpty {
            Text("\u{201E}\(quote)\u{201C}")
                .font(.footnote)
                .italic()
                .foregroundStyle(.secondary)
        }

        if proposal.needsChoice {
            Picker("Welcher Ort?", selection: Binding(
                get: { chosenOption[proposal.id] },
                set: { chosenOption[proposal.id] = $0 }
            )) {
                Text("Bitte w\u{00E4}hlen").tag(ShareProposal.Option?.none)
                ForEach(proposal.options) { option in
                    Text(optionLabel(option)).tag(ShareProposal.Option?.some(option))
                }
            }
        } else if proposal.needsDuration {
            let dwell = dwellBinding(proposal)
            Stepper(value: dwell, in: 5...480, step: 5) {
                Text("Aufenthalt: \(dwell.wrappedValue) Min.")
            }
        }

        if let outcome = addedOutcome[proposal.id] {
            Label(outcome, systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .font(.footnote)
        } else if proposal.canAdd {
            Button {
                Task { await add(proposal) }
            } label: {
                if addingId == proposal.id {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Wird \u{00FC}bernommen\u{2026}")
                    }
                } else {
                    Label("In den Vorrat", systemImage: "plus.circle")
                }
            }
            .disabled(!isReady(proposal) || addingId != nil)
        } else {
            Label("Kein Ort gefunden", systemImage: "mappin.slash")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Add

    private func add(_ proposal: ShareProposal) async {
        guard isReady(proposal), addedOutcome[proposal.id] == nil else { return }

        let chosen = chosenOption[proposal.id]
        let position = chosen.map { ShareProposal.Coordinate(lat: $0.lat, lon: $0.lon) }
            ?? proposal.position
        guard let position else { return }

        let needsDuration = proposal.needsDuration && chosen == nil
        let dwell = dwellMinutes[proposal.id] ?? Self.defaultDwellMinutes

        addingId = proposal.id
        defer { addingId = nil }
        do {
            let merged = try await ShareExtensionAPI.addFind(
                planId: planId,
                lat: position.lat,
                lon: position.lon,
                name: resolvedName(for: proposal, chosen: chosen),
                note: resolvedNote(for: proposal),
                sourceUrl: response.sourceUrl,
                legIndex: chosen?.legIndex ?? proposal.legIndex,
                dwellMinutes: needsDuration ? dwell : nil
            )
            addedOutcome[proposal.id] = merged
                ? "mit einem vorhandenen Eintrag zusammengef\u{00FC}hrt"
                : "im Vorrat"
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Helpers

    private func isReady(_ proposal: ShareProposal) -> Bool {
        guard addedOutcome[proposal.id] == nil else { return false }
        if proposal.needsChoice { return chosenOption[proposal.id] != nil }
        return true
    }

    private func dwellBinding(_ proposal: ShareProposal) -> Binding<Int> {
        Binding(
            get: { dwellMinutes[proposal.id] ?? Self.defaultDwellMinutes },
            set: { dwellMinutes[proposal.id] = $0 }
        )
    }

    private func resolvedName(for proposal: ShareProposal,
                              chosen: ShareProposal.Option?) -> String? {
        if !userTitle.isEmpty { return userTitle }
        return chosen?.name ?? proposal.name
    }

    private func resolvedNote(for proposal: ShareProposal) -> String? {
        var parts: [String] = []
        if !userNote.isEmpty { parts.append(userNote) }
        if let quote = proposal.quote, !quote.isEmpty {
            parts.append("\u{201E}\(quote)\u{201C}")
        }
        if let hint = proposal.placeHint, !hint.isEmpty { parts.append(hint) }
        return parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
    }

    private func proposalHeadline(_ proposal: ShareProposal) -> String {
        if !userTitle.isEmpty { return userTitle }
        return proposal.name ?? "Ohne Namen"
    }

    private func proposalHint(_ proposal: ShareProposal) -> String {
        switch proposal.verdict {
        case "unique":
            return "In OpenStreetMap gefunden \u{2014} \u{00D6}ffnungszeiten "
                + "und Dauer kommen von dort."
        case "coordinate":
            return "Aus dem Karten-Link. Kein OpenStreetMap-Eintrag dazu, "
                + "also fehlen \u{00D6}ffnungszeiten und Kategorie."
        case "ambiguous":
            return "Mehrere Orte hei\u{00DF}en so \u{2014} bitte ausw\u{00E4}hlen, "
                + "welcher gemeint ist."
        default:
            return proposal.position != nil
                ? "Kein OpenStreetMap-Eintrag \u{2014} \u{00D6}ffnungszeiten "
                    + "und Kategorie bleiben unbekannt."
                : "Kein Ort dazu gefunden."
        }
    }

    private func optionLabel(_ option: ShareProposal.Option) -> String {
        let name = option.name ?? option.osmRef
        guard let distance = option.distanceM else { return name }
        return distance >= 1_000
            ? "\(name) \u{2014} \(String(format: "%.1f", distance / 1_000)) km"
            : "\(name) \u{2014} \(Int(distance.rounded())) m"
    }
}
