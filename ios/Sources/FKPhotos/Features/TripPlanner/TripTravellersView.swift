import SwiftUI

/// Who is coming (§3.5).
///
/// "Wir" is not generic: two children under ten make a different day
/// from two adults. The planner has always been able to act on that —
/// it shrinks the time budget of every block — but the flags came from
/// a sentence somebody typed once, and a sentence does not have
/// birthdays. This screen puts the people in instead, and shows what
/// follows from them in words: a day that got shorter without saying
/// why reads as a bug (§3.8).
///
/// The one thing it never does is conclude "mehr Zeit einplanen" from an
/// age. How long a small child lasts is a fact about small children;
/// needing more time is a statement about a person, and it is asked
/// for, not assumed. (The switch was called "Kürzere Wege" once, which
/// promised something it never did: it shortens the blocks, not the
/// walks.)
struct TripTravellersView: View {
    let planId: Int
    /// Called after a change, because adding somebody re-plans the trip.
    var onPlanChanged: (() -> Void)?

    @State private var travellers: [TripTraveller] = []
    @State private var effect: TripGroupEffect?
    @State private var suggestions: [TripTravellerSuggestion] = []
    @State private var startsOn: String?
    @State private var isLoading = true
    @State private var busyId: Int?
    @State private var busyKey: String?
    @State private var errorMessage: String?
    /// The person about to be added — the first time, the re-plan is
    /// said out loud (§3.5): a day that got shorter without a word
    /// reads as a bug.
    @State private var confirmingAdd: TripTravellerSuggestion?
    @State private var confirmingRemove: TripTraveller?
    /// The form for somebody who is neither in the household nor
    /// planning the trip — a friend, a grandparent from elsewhere.
    @State private var enteringByHand = false
    @AppStorage("trip.travellers.replanExplained") private var replanExplained = false

    var body: some View {
        List {
            if isLoading && travellers.isEmpty && suggestions.isEmpty {
                Section { ProgressView() }
            }

            if !travellers.isEmpty {
                Section {
                    ForEach(travellers) { traveller in
                        row(for: traveller)
                    }
                } header: {
                    Text("Reisegruppe")
                } footer: {
                    if let effect, !effect.reasons.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(Array(effect.reasons.enumerated()), id: \.offset) { _, reason in
                                Text(reason)
                            }
                        }
                    }
                }
            }

            if !suggestions.isEmpty {
                Section {
                    ForEach(suggestions) { person in
                        suggestionRow(for: person)
                    }
                } header: {
                    Text("Aus dem Haushalt")
                } footer: {
                    Text("Vorgeschlagen, nicht eingetragen — eine Reise ist nicht automatisch "
                         + "jeder, der hier wohnt.")
                }
            }

            if !isLoading && travellers.isEmpty && suggestions.isEmpty {
                Section {
                    Text("Für diese Reise ist noch niemand eingetragen. Die Tage werden dann "
                         + "geplant, als wären alle erwachsen und gut zu Fuß.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            if !isLoading {
                // Not everybody who comes lives here or has a login.
                Section {
                    Button {
                        enteringByHand = true
                    } label: {
                        Label("Jemanden eintragen", systemImage: "person.badge.plus")
                    }
                } footer: {
                    Text("Für alle, die weder im Haushalt sind noch mitplanen.")
                }
            }
        }
        .sheet(isPresented: $enteringByHand) {
            NavigationStack {
                TripManualTravellerSheet { entry in
                    await add(entry)
                }
            }
            .presentationDetents([.medium, .large])
        }
        .navigationTitle("Reisegruppe")
        .plannerErrorBanner(errorMessage, retry: { await load() }, dismiss: { errorMessage = nil })
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
        .alert("Die Tage werden neu geplant", isPresented: Binding(
            get: { confirmingAdd != nil }, set: { if !$0 { confirmingAdd = nil } }),
               presenting: confirmingAdd) { person in
            Button("\(person.label) eintragen") {
                replanExplained = true
                Task { await add(person) }
            }
            Button("Abbrechen", role: .cancel) {}
        } message: { _ in
            Text("Wer mitfährt, bestimmt, wie viel in einen Tag passt. Mit jeder Änderung an "
                 + "der Reisegruppe werden die Tage neu verteilt; angeheftete Stopps bleiben.")
        }
        .confirmationDialog("Aus der Reisegruppe nehmen?", isPresented: Binding(
            get: { confirmingRemove != nil }, set: { if !$0 { confirmingRemove = nil } }),
            titleVisibility: .visible, presenting: confirmingRemove) { traveller in
            Button("\(traveller.label) entfernen", role: .destructive) {
                Task { await remove(traveller) }
            }
            Button("Abbrechen", role: .cancel) {}
        } message: { _ in
            Text("Die Tage werden danach neu geplant.")
        }
    }

    @ViewBuilder
    private func row(for traveller: TripTraveller) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(traveller.label)
                    if let subtitle = traveller.subtitle(startsOn: startsOn) {
                        Text(subtitle).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if busyId == traveller.id {
                    ProgressView()
                }
            }
            // A statement about a person, made by a person (§3.5). A
            // plain switch, as the HIG has it for a setting that is on
            // or off: the bordered button it used to be showed its
            // state as a tint only, and nobody could tell which way it
            // stood.
            Toggle(isOn: Binding(
                get: { traveller.shortWalks },
                set: { on in Task { await setShortWalks(on, for: traveller) } }
            )) {
                Text("Mehr Zeit einplanen").font(.subheadline)
            }
            .disabled(busyId == traveller.id)
        }
        .padding(.vertical, 2)
        // Taking somebody off the trip is the row's swipe, as a list
        // has it — not a minus button beside the switch, where a thumb
        // aiming for one landed on the other. The confirmation stays;
        // a swipe is not a decision about the days.
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                confirmingRemove = traveller
            } label: {
                Label("Entfernen", systemImage: "minus.circle")
            }
            .disabled(busyId == traveller.id)
        }
    }

    @ViewBuilder
    private func suggestionRow(for person: TripTravellerSuggestion) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(person.label)
                Text(person.subtitle).font(.footnote).foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                if replanExplained {
                    Task { await add(person) }
                } else {
                    confirmingAdd = person
                }
            } label: {
                if busyKey == person.id {
                    ProgressView()
                } else {
                    Image(systemName: "plus.circle")
                }
            }
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 2)
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let here: TripTravellersResponse = try await APIClient.shared.get(
                "/trip-planner/plans/\(planId)/travellers")
            travellers = here.travellers
            effect = here.effect
            startsOn = here.on
            errorMessage = nil
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
        // Apart from the list itself: a failing suggestions call used
        // to empty the working list of travellers too.
        do {
            let offered: TripTravellerSuggestionsResponse = try await APIClient.shared.get(
                "/trip-planner/plans/\(planId)/travellers/suggestions")
            suggestions = offered.suggestions
        } catch {
            if errorMessage == nil { errorMessage = TripErrorText.describe(error) }
        }
    }

    private func add(_ person: TripTravellerSuggestion) async {
        busyKey = person.id
        defer { busyKey = nil }
        do {
            let _: TripPlanResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/travellers",
                body: TripAddTravellerRequest(
                    subjectPersonId: person.subjectPersonId, userId: person.userId))
            await load()
            onPlanChanged?()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    /// Somebody entered by hand: a name, perhaps a birth date, perhaps
    /// shorter walks.
    private func add(_ entry: TripManualTraveller) async {
        do {
            let _: TripPlanResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/travellers",
                body: TripAddTravellerRequest(
                    subjectPersonId: nil, userId: nil,
                    label: entry.name, birthDate: entry.birthDateString,
                    shortWalks: entry.shortWalks))
            replanExplained = true
            await load()
            onPlanChanged?()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    private func setShortWalks(_ on: Bool, for traveller: TripTraveller) async {
        busyId = traveller.id
        defer { busyId = nil }
        do {
            let _: TripPlanResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/travellers/update",
                body: TripUpdateTravellerRequest(travellerId: traveller.id, shortWalks: on))
            await load()
            onPlanChanged?()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    private func remove(_ traveller: TripTraveller) async {
        busyId = traveller.id
        defer { busyId = nil }
        do {
            let _: TripPlanResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/travellers/remove",
                body: TripRemoveTravellerRequest(travellerId: traveller.id))
            await load()
            onPlanChanged?()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }
}

struct TripTravellersResponse: Codable, Sendable {
    let travellers: [TripTraveller]
    /// The date the ages were computed against, or nil when undated.
    let on: String?
    let effect: TripGroupEffect
}

struct TripTravellerSuggestionsResponse: Codable, Sendable {
    let suggestions: [TripTravellerSuggestion]
}

struct TripAddTravellerRequest: Encodable, Sendable {
    /// One of the household …
    let subjectPersonId: Int?
    /// … or somebody who plans this trip (§6.2) …
    let userId: Int?
    /// … or somebody who is neither: a name, perhaps a birth date.
    /// Exactly one of the three ways is used.
    var label: String? = nil
    var birthDate: String? = nil
    var shortWalks: Bool? = nil
}

struct TripRemoveTravellerRequest: Encodable, Sendable {
    let travellerId: Int
}

struct TripUpdateTravellerRequest: Encodable, Sendable {
    let travellerId: Int
    let shortWalks: Bool
}

/// What the form for somebody entered by hand collects (§3.5).
///
/// Kept apart from the view so the one piece with a wrong answer — the
/// date as the server wants it — can be checked without a screen. The
/// birth date is a date, not an instant: formatted in the local
/// calendar so somebody born on the 2nd stays born on the 2nd east of
/// Greenwich.
struct TripManualTraveller: Sendable, Equatable {
    var name: String
    var birthDate: Date?
    var shortWalks: Bool

    /// The name as it will be sent, or nil when there is none.
    var trimmedName: String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    var isValid: Bool { trimmedName != nil }

    /// `YYYY-MM-DD` in the local calendar, or nil when no date was given.
    var birthDateString: String? {
        birthDate.map { Self.isoDate($0) }
    }

    static func isoDate(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }
}

/// The form behind "Jemanden eintragen".
struct TripManualTravellerSheet: View {
    /// Called with the entry once it is saved; the sheet closes after.
    let onSave: (TripManualTraveller) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var knowsBirthDate = false
    @State private var birthDate = Calendar.current.date(byAdding: .year, value: -30, to: Date()) ?? Date()
    @State private var shortWalks = false
    @State private var isSaving = false

    private var entry: TripManualTraveller {
        TripManualTraveller(
            name: name,
            birthDate: knowsBirthDate ? birthDate : nil,
            shortWalks: shortWalks,
        )
    }

    var body: some View {
        Form {
            Section {
                TextField("Name", text: $name)
                    .textInputAutocapitalization(.words)
            }
            Section {
                Toggle("Geburtsdatum angeben", isOn: $knowsBirthDate)
                if knowsBirthDate {
                    DatePicker("Geburtsdatum", selection: $birthDate,
                               in: ...Date(), displayedComponents: .date)
                }
            } footer: {
                Text("Mit Geburtsdatum weiß der Planer, ob ein Kind mitfährt. Ohne wird "
                     + "die Person als erwachsen geplant.")
            }
            Section {
                Toggle("Mehr Zeit einplanen", isOn: $shortWalks)
            } footer: {
                // What it does, in the terms the plan uses: less in a
                // block, not shorter walks — the name it had once
                // promised the latter.
                Text("Jeder Block bekommt dann weniger Programm — mehr Zeit pro Ort, mehr "
                     + "Pausen. Die Weglängen ändert das nicht. Wird nie aus dem Alter "
                     + "geschlossen — nur, wenn du es hier sagst.")
            }
        }
        .navigationTitle("Jemanden eintragen")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Abbrechen") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Sichern") {
                    guard let trimmedName = entry.trimmedName else { return }
                    isSaving = true
                    var saved = entry
                    saved.name = trimmedName
                    Task {
                        await onSave(saved)
                        isSaving = false
                        dismiss()
                    }
                }
                .disabled(!entry.isValid || isSaving)
            }
        }
    }
}

struct TripGroupEffect: Codable, Sendable {
    let withChildren: Bool
    let limitedMobility: Bool
    /// Why the days look the way they do, in words (§3.8).
    let reasons: [String]
}

struct TripTraveller: Codable, Identifiable, Sendable {
    let id: Int
    let subjectPersonId: Int?
    let label: String
    let birthDate: String?
    /// Set by a person, never derived from an age.
    let shortWalks: Bool
    /// Age at the start of the trip — the age that plans it.
    let ageAtStart: Int?

    /// What is known about them, and nothing that is not: no age when
    /// no birth date was given, rather than a guess. The time flag is
    /// not repeated here — the switch on the row says it, and a line
    /// that says it again is noise.
    func subtitle(startsOn: String?) -> String? {
        guard let ageAtStart else { return nil }
        return startsOn == nil ? "\(ageAtStart)" : "\(ageAtStart) bei Reisebeginn"
    }
}

struct TripTravellerSuggestion: Codable, Identifiable, Sendable {
    /// Household entries and accounts are numbered separately, so the
    /// row id says which kind this is rather than colliding with it.
    var id: String {
        subjectPersonId.map { "person:\($0)" } ?? userId.map { "user:\($0)" } ?? label
    }
    /// The household entry, when this is one …
    let subjectPersonId: Int?
    /// … or the account of somebody who plans the trip (§6.2).
    let userId: Int?
    let label: String
    let relation: String
    let birthDate: String?
    let ageAtStart: Int?

    var subtitle: String {
        guard let ageAtStart else { return relation }
        return "\(relation) · \(ageAtStart) bei Reisebeginn"
    }
}
