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
    @State private var editingDayShape = false
    @Environment(\.dismiss) private var dismiss

    /// Kept beside the model because the day-shape editor is its own
    /// screen with its own request — it does not go through the
    /// settings save.
    private let planId: Int
    /// A trip of ideas: its day is one window, and nothing is searched
    /// but the highlights (ideen-statt-pool.md).
    private let ideas: Bool

    /// Called after a successful save, so the day screen reloads.
    let onSaved: () -> Void

    init(
        planId: Int,
        constraints: TripConstraints?,
        title: String?,
        startDate: String? = nil,
        onSaved: @escaping () -> Void,
    ) {
        _model = State(initialValue: TripPlanSettingsViewModel(
            planId: planId, constraints: constraints, title: title, startDate: startDate))
        self.planId = planId
        self.ideas = constraints?.ideas == true
        self.onSaved = onSaved
    }

    /// What the interest toggles do, said for the kind of trip.
    private var interestsFooter: String {
        if ideas {
            return "Die Highlights eines Aufenthalts zeigen nur, was angekreuzt ist. "
                + "„Alles andere“ steht für Orte, die zu keinem der Themen gehören."
        }
        return "Gesucht wird nur, was angekreuzt ist. „Alles andere“ steht für "
            + "Orte, die zu keinem der Themen gehören — alles an heißt alles, "
            + "was die Karte kennt. Die Liste ist kurz, weil sie nur enthält, was "
            + "OpenStreetMap wirklich unterscheidet: „Burgen“ kann die Karte "
            + "beantworten, „Barock“ nicht.\n\nSpeichern plant die Tage neu."
    }

    var body: some View {
        Form {
            Section {
                TextField("Name der Reise", text: $model.title)
            } header: {
                Text("Name")
            } footer: {
                // The date is the "Von" of the first stay or of the way
                // there (reise-planen-und-unterwegs.md, stage 2): one
                // place for the chain, not a second copy of it here.
                Text("Das Datum der Reise ist das „Von“ des ersten Aufenthalts oder der Anreise, "
                     + "im Reiseverlauf. Ankunft, Abfahrt und Verkehrsmittel stehen dort auch.")
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
                Text("Tempo und Begleitung")
            } footer: {
                Text("Gilt für die ganze Reise und bestimmt, wie viel an einem Tag Platz hat. "
                     + "Sichern plant die Tage neu. Wie ihr vor Ort unterwegs seid, steht je "
                     + "Aufenthalt im Reiseverlauf.")
            }

            Section {
                Toggle("Abstimmen", isOn: $model.voting)
            } header: {
                Text("Planen mit")
            } footer: {
                Text("Mit Abstimmung zeigt die Liste je Ort einen Ring für Herzenswunsch, Gern und "
                     + "Lieber nicht, dazu Fairness und „Damit neu planen“. Ohne sie entscheidet ihr "
                     + "über die Priorität jeder Idee.")
            }

            // A trip of ideas has no Vormittag or Nachmittag to change:
            // its day is one window (ideen-statt-pool.md, stage 4).
            if !ideas {
                Section {
                    Button {
                        editingDayShape = true
                    } label: {
                        Label("Tagesablauf ändern", systemImage: "list.bullet.indent")
                    }
                } footer: {
                    // §4.1: the four-part day is a default, not a fixed
                    // set — this is where it stops being fixed.
                    Text("Vormittag, Mittagspause, Nachmittag, Abend sind ein Vorschlag. "
                         + "Blöcke lassen sich umbenennen, verlängern, verschieben und "
                         + "streichen — die Mittagspause zum Beispiel.")
                }
            }

            if !model.options.isEmpty {
                Section {
                    ForEach(model.options) { option in
                        Toggle(option.label, isOn: Binding(
                            get: { model.interests.contains(option.id) },
                            set: { on in
                                if on { model.interests.insert(option.id) }
                                else { model.interests.remove(option.id) }
                            },
                        ))
                    }
                } header: {
                    Text(ideas ? "Was die Highlights zeigen" : "Wonach gesucht wird")
                } footer: {
                    // A filter, not a bonus (2026-10-04): what it does,
                    // what the last line is for, and why the list is
                    // short (§4, interests.ts).
                    Text(interestsFooter)
                }
            }

        }
        .navigationTitle("Einstellungen")
        .plannerErrorBanner(model.errorMessage)
        .navigationBarTitleDisplayMode(.inline)
        // The server's refusal to re-plan is a question with two
        // answers. As a section it sat below the interest list, where
        // "Speichern" appeared to do nothing.
        .alert("Tage neu planen?", isPresented: Binding(
            get: { model.blockedReason != nil },
            set: { if !$0 { model.clearBlockedReason() } }),
               presenting: model.blockedReason) { _ in
            Button("Nur speichern, Tage lassen") {
                Task { await save(replan: false) }
            }
            Button("Abbrechen", role: .cancel) { model.clearBlockedReason() }
        } message: { reason in
            Text(reason)
        }
        .task { await model.loadInterests() }
        .sheet(isPresented: $editingDayShape) {
            TripDayShapeView(planId: planId, onSaved: onSaved)
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Abbrechen") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    Task { await save(replan: true) }
                } label: {
                    if model.isSaving { ProgressView() } else { Text("Sichern") }
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
    /// Whether the trip has dates at all. A trip planned for "some
    /// time" is a real plan, and turning this off says so rather than
    /// leaving a date nobody meant.
    var isDated: Bool
    var startDate: Date
    /// „Abstimmen“ under „Planen mit“ (ideas plan, stage 7).
    var voting: Bool

    private(set) var isSaving = false
    /// Set when the server refused to re-plan because the trip has
    /// started. Shown with the way out rather than as a dead end.
    private(set) var blockedReason: String?

    func clearBlockedReason() { blockedReason = nil }
    private(set) var errorMessage: String?

    private let planId: Int
    private let categories: [String]?
    /// What the trip is planned for (§4). Editable here now: the
    /// setting existed from the start and had no screen, so the only
    /// way to say "wir mögen Burgen" was the sentence when the trip was
    /// created — and never afterwards.
    var interests: Set<String>
    /// The vocabulary the server can actually match, fetched rather
    /// than copied: two lists would drift the first time a tag is added
    /// to one of them, and the failure would be silent.
    private(set) var options: [TripInterestOption] = []

    private let maxWalkMinutes: Int?

    /// What the trip's dates were when the screen opened, so a save
    /// that did not touch them sends nothing at all.
    private let originalStartDate: String?

    init(
        planId: Int,
        constraints: TripConstraints?,
        title: String?,
        startDate: String? = nil,
    ) {
        self.planId = planId
        self.title = title ?? ""
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
        // Everything stored stays in the set, including free text from
        // the interpreter that this vocabulary has no toggle for
        // ("barock"). It rides along untouched and goes back on save —
        // a screen that quietly deleted an answer somebody gave would
        // be worse than one that cannot show it.
        self.interests = Set(constraints?.interests ?? [])
        self.maxWalkMinutes = constraints?.maxWalkMinutes
        self.voting = constraints?.isVoting ?? true
    }

    /// What to send for the dates: nothing, a date, or an explicit
    /// null. Nil means "not mentioned", `.some(nil)` means "take the
    /// dates off".
    var dateChange: String?? {
        let wanted = isDated ? TripCalendar.isoDay(startDate) : nil
        if wanted == originalStartDate { return nil }
        return .some(wanted)
    }

    /// The interests the planner can match, from the server.
    ///
    /// Silent on failure: without the list the section shows nothing,
    /// which is the same as before this screen existed — an error
    /// banner over the settings because a side list could not be
    /// fetched helps nobody.
    func loadInterests() async {
        struct Response: Decodable { let interests: [TripInterestOption] }
        do {
            let response: Response = try await APIClient.shared.get("/trip-planner/interests")
            options = response.interests
            // Nothing stored means everything is searched (the server
            // reads it so too): show that as every line ticked rather
            // than none, which read as "nothing counts".
            if !options.contains(where: { interests.contains($0.id) }) {
                interests.formUnion(options.map(\.id))
            }
        } catch {
            options = []
        }
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
            /// Double optional on purpose: absent leaves the dates
            /// alone, explicit null takes them off. `encodeIfPresent`
            /// tells the two apart; a plain optional could not.
            let startDate: String??
            let voting: Bool
            let replan: Bool
            struct Group: Encodable { let withChildren: Bool; let limitedMobility: Bool }

            enum CodingKeys: String, CodingKey {
                case title, pace, group, categories, interests, maxWalkMinutes
                case startDate, voting, replan
            }

            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(title, forKey: .title)
                try c.encode(pace, forKey: .pace)
                try c.encode(group, forKey: .group)
                try c.encodeIfPresent(categories, forKey: .categories)
                try c.encodeIfPresent(interests, forKey: .interests)
                try c.encodeIfPresent(maxWalkMinutes, forKey: .maxWalkMinutes)
                if let startDate { try c.encode(startDate, forKey: .startDate) }
                try c.encode(voting, forKey: .voting)
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
                    interests: Array(interests).sorted(),
                    maxWalkMinutes: maxWalkMinutes,
                    startDate: dateChange,
                    voting: voting,
                    replan: replan,
                ))
            errorMessage = nil
            blockedReason = nil
        } catch {
            let message = TripErrorText.describe(error)
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
        return true
    }
}

/// One entry of the interest vocabulary, as the server offers it.
struct TripInterestOption: Codable, Identifiable, Sendable {
    let id: String
    let label: String
}
