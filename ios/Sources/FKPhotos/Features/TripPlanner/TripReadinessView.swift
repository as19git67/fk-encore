import SwiftUI

/// The evening before (§8.6).
///
/// A list over states that already exist, and that is the whole point:
/// the two failures that actually spoil a trip — no map data abroad, no
/// ticket to hand — are an evening's work to fix and a catastrophe at
/// the platform. Nothing here computes anything new; it puts four
/// answers on one screen at the moment they can still be acted on.
///
/// One row does not come from the server: whether the plan is on the
/// phone (§3.9). Only the device knows that, so the server does not
/// pretend to and this screen fills it in from the store.
struct TripReadinessView: View {
    @State var viewModel: TripPlannerViewModel

    @State private var readiness: TripReadiness?
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        List {
            if isLoading && readiness == nil {
                Section { ProgressView() }
            }

            if let readiness {
                Section {
                    ForEach(rows(readiness)) { row in
                        Label {
                            Text(row.sentence)
                                .font(.footnote)
                                .foregroundStyle(row.state == "unknown" ? .secondary : .primary)
                        } icon: {
                            Image(systemName: row.symbolName)
                                .foregroundStyle(row.tint)
                        }
                    }
                } header: {
                    Text(readiness.startsOn == nil ? "Vor der Reise" : "Vor dem \(readiness.startsOn!)")
                } footer: {
                    Text("Nichts davon ist neu berechnet — es sind vorhandene Zustände an "
                         + "einer Stelle, solange sie noch billig zu ändern sind.")
                }

                if readiness.packing.isEmpty {
                    Section {
                        Text(readiness.forecastUntil == nil
                             ? "Für die Packliste fehlt noch die Wettervorhersage — so weit "
                               + "voraus gibt es keine."
                             : "Aus diesem Plan ergibt sich nichts Besonderes zum Einpacken.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } header: {
                        Text("Packliste")
                    }
                } else {
                    Section {
                        ForEach(readiness.packing) { item in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.label)
                                Text(item.reason)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    } header: {
                        Text("Packliste")
                    } footer: {
                        // Why it is short, and why that is the feature
                        // (§8.6).
                        Text("Abgeleitet aus diesem Plan, diesem Wetter und dieser Gruppe — "
                             + "kein „zehn Dinge für Japan“. Deshalb steht hier nichts, was "
                             + "sich nicht aus dem Plan ergibt.")
                    }
                }
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).font(.footnote).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Reisebereit?")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    /// The server's checks plus the one only the phone can answer.
    private func rows(_ readiness: TripReadiness) -> [TripReadinessCheck] {
        readiness.checks + [offlineRow]
    }

    /// Read from the store rather than from the view model, so the row
    /// is right even when this screen was opened before the day plan
    /// had a chance to look.
    private var offlineRow: TripReadinessCheck {
        TripReadinessCheck.offline(
            storedAt: viewModel.offlineStore.storedAt(planId: viewModel.planId))
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            readiness = try await APIClient.shared.get(
                "/trip-planner/plans/\(viewModel.planId)/readiness",
                query: ["utcOffsetMinutes": String(TimeZone.current.secondsFromGMT() / 60)])
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct TripReadiness: Codable, Sendable {
    let startsOn: String?
    let checks: [TripReadinessCheck]
    let packing: [TripPackingItem]
    /// The last date the forecast reached, or nil where none did.
    let forecastUntil: String?
}

struct TripReadinessCheck: Codable, Identifiable, Sendable {
    let id: String
    /// ok | attention | unknown.
    let state: String
    let sentence: String

    var symbolName: String {
        switch state {
        case "ok": return "checkmark.circle"
        case "attention": return "exclamationmark.triangle"
        default: return "questionmark.circle"
        }
    }

    /// Amber for what to do tonight, grey for what the app cannot say.
    /// A question the app cannot answer is not a warning — dressing it
    /// as one would teach people to ignore the warnings.
    var tint: Color {
        switch state {
        case "ok": return .green
        case "attention": return .orange
        default: return .secondary
        }
    }
}

extension TripReadinessCheck {
    /// The one check the server cannot make (§3.9): only the device
    /// knows whether the plan is on it.
    static func offline(storedAt: Date?) -> TripReadinessCheck {
        guard let storedAt else {
            return TripReadinessCheck(
                id: "offline", state: "attention",
                sentence: "Der Plan ist noch nicht fürs Gerät geladen. Ohne Netz wäre er dann "
                    + "nicht da.")
        }
        return TripReadinessCheck(
            id: "offline", state: "ok",
            sentence: "Der Plan liegt auf dem Gerät — \(TripOfflineWording.stamp(storedAt)).")
    }
}

struct TripPackingItem: Codable, Identifiable, Sendable {
    let id: String
    let label: String
    let reason: String
}
