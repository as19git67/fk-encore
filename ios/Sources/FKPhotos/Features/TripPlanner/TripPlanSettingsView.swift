import SwiftUI

/// Changing how a trip is planned, after it was planned (§4.1, §6.2).
///
/// The pace, who is travelling and what they like could be set exactly
/// once, on the screen that created the trip, and nowhere afterwards —
/// which is the wrong shape for a setting you learn on the second day.
///
/// The screen is honest about what saving does: it **re-plans the
/// days**, because the pace and the group scale a block's budget and a
/// stored value that left the days alone would be a switch with nothing
/// behind it. The legs, their anchors and dates stay, and so does
/// everything anybody put in the pool by hand (§9.2).
struct TripPlanSettingsView: View {
    @State private var model: TripPlanSettingsViewModel
    @Environment(\.dismiss) private var dismiss

    /// Called after a successful save, so the day screen reloads.
    let onSaved: () -> Void

    init(planId: Int, constraints: TripConstraints?, title: String?, onSaved: @escaping () -> Void) {
        _model = State(initialValue: TripPlanSettingsViewModel(
            planId: planId, constraints: constraints, title: title))
        self.onSaved = onSaved
    }

    var body: some View {
        Form {
            Section("Name") {
                TextField("Name der Reise", text: $model.title)
            }

            Section {
                Picker("Tempo", selection: $model.pace) {
                    ForEach(TripPace.allCases, id: \.self) { pace in
                        Text(pace.label).tag(pace)
                    }
                }
                Toggle("Mit Kind", isOn: $model.withChildren)
                Toggle("Schlecht zu Fuß", isOn: $model.limitedMobility)
            } header: {
                Text("Wie?")
            } footer: {
                Text("Tempo und Begleitung bestimmen, wie viel an einem Tag Platz hat. "
                     + "Speichern plant die Tage neu.")
            }

            if let blocked = model.blockedReason {
                Section {
                    Label(blocked, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button("Nur speichern, Tage lassen") {
                        Task { await save(replan: false) }
                    }
                }
            }

            if let errorMessage = model.errorMessage {
                Section {
                    Text(errorMessage).font(.footnote).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Einstellungen")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Abbrechen") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    Task { await save(replan: true) }
                } label: {
                    if model.isSaving { ProgressView() } else { Text("Speichern") }
                }
                .disabled(model.isSaving)
            }
        }
    }

    private func save(replan: Bool) async {
        if await model.save(replan: replan) {
            onSaved()
            dismiss()
        }
    }
}

@Observable @MainActor
final class TripPlanSettingsViewModel {
    var title: String
    var pace: TripPace
    var withChildren: Bool
    var limitedMobility: Bool

    private(set) var isSaving = false
    /// Set when the server refused to re-plan because the trip has
    /// started. Shown with the way out rather than as a dead end.
    private(set) var blockedReason: String?
    private(set) var errorMessage: String?

    private let planId: Int
    private let categories: [String]?
    private let interests: [String]?
    private let maxWalkMinutes: Int?

    init(planId: Int, constraints: TripConstraints?, title: String?) {
        self.planId = planId
        self.title = title ?? ""
        self.pace = constraints?.pace.flatMap(TripPace.init(rawValue:)) ?? .normal
        self.withChildren = constraints?.group?.withChildren ?? false
        self.limitedMobility = constraints?.group?.limitedMobility ?? false
        // Carried through untouched: this screen does not edit them, and
        // omitting them from the request would make the server keep its
        // stored values anyway — sending them back is belt and braces
        // against a future field being dropped by a round trip.
        self.categories = constraints?.categories
        self.interests = constraints?.interests
        self.maxWalkMinutes = constraints?.maxWalkMinutes
    }

    /// Answers true when the plan was saved.
    func save(replan: Bool) async -> Bool {
        isSaving = true
        defer { isSaving = false }
        struct Body: Encodable {
            let title: String
            let pace: String
            let group: Group
            let categories: [String]?
            let interests: [String]?
            let maxWalkMinutes: Int?
            let replan: Bool
            struct Group: Encodable { let withChildren: Bool; let limitedMobility: Bool }
        }
        struct Response: Decodable { let plan: TripPlan }
        do {
            let _: Response = try await APIClient.shared.patch(
                "/trip-planner/plans/\(planId)/settings",
                body: Body(
                    title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                    pace: pace.rawValue,
                    group: .init(withChildren: withChildren, limitedMobility: limitedMobility),
                    categories: categories,
                    interests: interests,
                    maxWalkMinutes: maxWalkMinutes,
                    replan: replan,
                ))
            errorMessage = nil
            blockedReason = nil
            return true
        } catch {
            let message = error.localizedDescription
            // The server's refusal is a sentence the traveller can act
            // on, and it comes with an alternative — so it is offered as
            // one rather than shown in red as a failure.
            if message.contains("abgehakt") {
                blockedReason = message
                errorMessage = nil
            } else {
                errorMessage = message
            }
            return false
        }
    }
}
