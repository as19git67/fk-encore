import SwiftUI

/// What `POST /trip-planner/routing/measure` answers (§24).
struct TripRoutingMeasurement: Decodable, Sendable {
    struct Mode: Decodable, Sendable, Identifiable {
        let mode: String
        let pairs: Int
        let answered: Int
        let offByQuarter: Int
        let medianDeviationPct: Double?
        let medianDifferenceMinutes: Double?
        var id: String { mode }
    }

    struct Worst: Decodable, Sendable, Identifiable {
        let mode: String
        let from: String
        let to: String
        let planTitle: String?
        let estimateMinutes: Int
        let routerMinutes: Int
        var id: String { "\(mode)|\(from)|\(to)" }
    }

    let pairs: Int
    let modes: [Mode]
    let worst: [Worst]
    let worthwhile: Bool

    static func run() async throws -> TripRoutingMeasurement {
        struct Empty: Encodable {}
        return try await APIClient.shared.post("/trip-planner/routing/measure", body: Empty())
    }
}

/// "Reisezeiten prüfen": the planner's estimate next to the router, on
/// the traveller's own planned days, with one tap (§24, before stage 2).
///
/// Nothing about a plan changes. The answer is whether letting the
/// router decide the plan's travel times would be worth it — and where
/// the estimate is furthest off, so the claim can be checked on a map.
struct TripRoutingMeasureView: View {
    @State private var result: TripRoutingMeasurement?
    @State private var running = false
    @State private var error: String?

    var body: some View {
        List {
            Section {
                Button {
                    Task { await run() }
                } label: {
                    HStack {
                        Label(result == nil ? "Vergleich starten" : "Erneut vergleichen",
                              systemImage: "arrow.triangle.swap")
                        Spacer()
                        if running { ProgressView() }
                    }
                }
                .disabled(running)
                if let error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            } footer: {
                Text("Vergleicht die geschätzten Reisezeiten deiner geplanten Tage mit dem "
                     + "Routing-Dienst – Unterkunft, Stopps und zurück, bis zu 80 Wege. "
                     + "An den Reisen ändert sich nichts.")
            }

            if let result {
                Section {
                    verdict(result)
                }

                if !result.modes.isEmpty {
                    Section("Je Fortbewegung") {
                        ForEach(result.modes) { mode in
                            modeRow(mode)
                        }
                    }
                }

                if !result.worst.isEmpty {
                    Section {
                        ForEach(result.worst) { pair in
                            worstRow(pair)
                        }
                    } header: {
                        Text("Am weitesten daneben")
                    }
                }
            }
        }
        .navigationTitle("Reisezeiten prüfen")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func verdict(_ result: TripRoutingMeasurement) -> some View {
        let answered = result.modes.reduce(0) { $0 + $1.answered }
        if result.pairs == 0 {
            Label("Keine geplanten Tage mit Stopps – erst eine Reise planen, dann vergleichen.",
                  systemImage: "calendar.badge.exclamationmark")
                .foregroundStyle(.secondary)
        } else if answered == 0 {
            Label("Der Routing-Dienst hat keinen der \(result.pairs) Wege beantwortet – "
                  + "nicht erreichbar oder ohne Kacheln für diese Gegend.",
                  systemImage: "exclamationmark.triangle")
                .foregroundStyle(.orange)
        } else if result.worthwhile {
            Label("Die Schätzung liegt oft mehr als ein Viertel daneben – echte Reisezeiten "
                  + "würden die Pläne spürbar verbessern.",
                  systemImage: "checkmark.seal")
                .foregroundStyle(.green)
        } else {
            Label("Die Schätzung trifft meist – echte Reisezeiten würden wenig ändern.",
                  systemImage: "equal.circle")
                .foregroundStyle(.secondary)
        }
    }

    private func modeRow(_ mode: TripRoutingMeasurement.Mode) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(Self.modeLabel(mode.mode), systemImage: Self.modeIcon(mode.mode))
                .font(.headline)
            Text("\(mode.answered) von \(mode.pairs) Wegen beantwortet, "
                 + "\(mode.offByQuarter) davon mehr als ein Viertel daneben")
                .font(.subheadline)
            if let pct = mode.medianDeviationPct, let diff = mode.medianDifferenceMinutes {
                Text("Typische Abweichung \(Int(pct)) % · "
                     + Self.signedMinutes(Int(diff)))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    private func worstRow(_ pair: TripRoutingMeasurement.Worst) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(pair.from) → \(pair.to)")
                .font(.subheadline)
            Text("Geschätzt \(pair.estimateMinutes) min · Router \(pair.routerMinutes) min · "
                 + Self.modeLabel(pair.mode)
                 + (pair.planTitle.map { " · \($0)" } ?? ""))
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private func run() async {
        running = true
        defer { running = false }
        do {
            result = try await TripRoutingMeasurement.run()
            error = nil
        } catch {
            self.error = TripErrorText.describe(error)
        }
    }

    static func modeLabel(_ mode: String) -> String {
        switch mode {
        case "foot": return "Zu Fuß"
        case "bike": return "Fahrrad"
        case "car": return "Auto"
        case "transit": return "ÖPNV"
        default: return mode
        }
    }

    static func modeIcon(_ mode: String) -> String {
        switch mode {
        case "foot": return "figure.walk"
        case "bike": return "bicycle"
        case "car": return "car"
        default: return "tram"
        }
    }

    /// Positive: the router needs longer than the estimate said.
    static func signedMinutes(_ diff: Int) -> String {
        if diff == 0 { return "im Mittel gleich lang" }
        return diff > 0
            ? "Router im Mittel \(diff) min länger"
            : "Router im Mittel \(-diff) min kürzer"
    }
}
