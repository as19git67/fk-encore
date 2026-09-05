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

    init(
        planId: Int,
        constraints: TripConstraints?,
        title: String?,
        mode: TripTransportMode = .foot,
        startDate: String? = nil,
        onSaved: @escaping () -> Void,
    ) {
        _model = State(initialValue: TripPlanSettingsViewModel(
            planId: planId, constraints: constraints, title: title,
            mode: mode, startDate: startDate))
        self.onSaved = onSaved
    }

    var body: some View {
        Form {
            Section("Name") {
                TextField("Name der Reise", text: $model.title)
            }

            Section {
                Toggle("Termin steht fest", isOn: $model.isDated)
                if model.isDated {
                    DatePicker("Erster Tag", selection: $model.startDate,
                               displayedComponents: .date)
                }
            } header: {
                Text("Wann?")
            } footer: {
                // Why this is worth setting: it is the whole mechanism
                // behind "die Reise läuft". There is no start button.
                Text("Mit einem Datum weiß die App, welcher Tag heute ist, und öffnet die "
                     + "Reise unterwegs auf dem richtigen Tag. Die Tage werden dabei nicht "
                     + "neu geplant.")
            }

            Section {
                Picker("Unterwegs", selection: $model.mode) {
                    ForEach(TripTransportMode.allCases, id: \.self) { mode in
                        Label(mode.label, systemImage: mode.systemImage).tag(mode)
                    }
                }
                Text(model.mode.hint)
                    .font(.caption)
                    .foregroundStyle(.secondary)
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
                Text("Verkehrsmittel, Tempo und Begleitung bestimmen, wie viel an einem Tag "
                     + "Platz hat. Speichern plant die Tage neu.\n\n"
                     + "„\(TripTransportMode.transit.label)“ ist der Regelfall in einer Stadt: "
                     + "kurze Wege werden gelaufen, lange gefahren — je Weg das, was schneller "
                     + "ist.")
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
    /// How the group gets around. One value for the whole trip, which
    /// is the question this screen asks; a trip through three cities
    /// with three different modes is a leg editor, and that is a
    /// different screen.
    var mode: TripTransportMode
    /// Whether the trip has dates at all. A trip planned for "some
    /// time" is a real plan, and turning this off says so rather than
    /// leaving a date nobody meant.
    var isDated: Bool
    var startDate: Date

    private(set) var isSaving = false
    /// Set when the server refused to re-plan because the trip has
    /// started. Shown with the way out rather than as a dead end.
    private(set) var blockedReason: String?
    private(set) var errorMessage: String?

    private let planId: Int
    private let categories: [String]?
    private let interests: [String]?
    private let maxWalkMinutes: Int?

    /// What the trip's dates were when the screen opened, so a save
    /// that did not touch them sends nothing at all.
    private let originalStartDate: String?
    private let originalMode: TripTransportMode

    init(
        planId: Int,
        constraints: TripConstraints?,
        title: String?,
        mode: TripTransportMode = .foot,
        startDate: String? = nil,
    ) {
        self.planId = planId
        self.title = title ?? ""
        self.mode = mode
        self.originalMode = mode
        self.originalStartDate = startDate
        self.isDated = startDate != nil
        self.startDate = startDate.flatMap { TripCalendar.date(fromIsoDay: $0) } ?? Date()
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

    /// What to send for the dates: nothing, a date, or an explicit
    /// null. Nil means "not mentioned", `.some(nil)` means "take the
    /// dates off".
    var dateChange: String?? {
        let wanted = isDated ? TripCalendar.isoDay(startDate) : nil
        if wanted == originalStartDate { return nil }
        return .some(wanted)
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
            let mode: String?
            /// Double optional on purpose: absent leaves the dates
            /// alone, explicit null takes them off. `encodeIfPresent`
            /// tells the two apart; a plain optional could not.
            let startDate: String??
            let replan: Bool
            struct Group: Encodable { let withChildren: Bool; let limitedMobility: Bool }

            enum CodingKeys: String, CodingKey {
                case title, pace, group, categories, interests, maxWalkMinutes
                case mode, startDate, replan
            }

            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(title, forKey: .title)
                try c.encode(pace, forKey: .pace)
                try c.encode(group, forKey: .group)
                try c.encodeIfPresent(categories, forKey: .categories)
                try c.encodeIfPresent(interests, forKey: .interests)
                try c.encodeIfPresent(maxWalkMinutes, forKey: .maxWalkMinutes)
                try c.encodeIfPresent(mode, forKey: .mode)
                if let startDate { try c.encode(startDate, forKey: .startDate) }
                try c.encode(replan, forKey: .replan)
            }
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
                    // Only when it actually changed: sending the mode
                    // unchanged would turn every save into a re-plan,
                    // and a re-plan is refused once a day has begun.
                    mode: mode == originalMode ? nil : mode.rawValue,
                    startDate: dateChange,
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
