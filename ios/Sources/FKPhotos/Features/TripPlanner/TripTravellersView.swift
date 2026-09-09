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
/// The one thing it never does is conclude "kürzere Wege" from an age.
/// How long a small child lasts is a fact about small children; needing
/// shorter distances is a statement about a person, and it is asked
/// for, not assumed.
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
    @State private var errorMessage: String?

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
                    Text("Fährt mit")
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

            if let errorMessage {
                Section {
                    Text(errorMessage).font(.footnote).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Wer fährt mit?")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    @ViewBuilder
    private func row(for traveller: TripTraveller) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(traveller.label)
                if let subtitle = traveller.subtitle(startsOn: startsOn) {
                    Text(subtitle).font(.footnote).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button(role: .destructive) {
                Task { await remove(traveller) }
            } label: {
                if busyId == traveller.id {
                    ProgressView()
                } else {
                    Image(systemName: "minus.circle")
                }
            }
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 2)
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
                Task { await add(person) }
            } label: {
                if busyId == person.subjectPersonId {
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
            let offered: TripTravellerSuggestionsResponse = try await APIClient.shared.get(
                "/trip-planner/plans/\(planId)/travellers/suggestions")
            travellers = here.travellers
            effect = here.effect
            startsOn = here.on
            suggestions = offered.suggestions
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func add(_ person: TripTravellerSuggestion) async {
        busyId = person.subjectPersonId
        defer { busyId = nil }
        do {
            let _: TripPlanResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/travellers",
                body: TripAddTravellerRequest(subjectPersonId: person.subjectPersonId))
            await load()
            onPlanChanged?()
        } catch {
            errorMessage = error.localizedDescription
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
            errorMessage = error.localizedDescription
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
    let subjectPersonId: Int
}

struct TripRemoveTravellerRequest: Encodable, Sendable {
    let travellerId: Int
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
    /// no birth date was given, rather than a guess.
    func subtitle(startsOn: String?) -> String? {
        var parts: [String] = []
        if let ageAtStart {
            parts.append(startsOn == nil ? "\(ageAtStart)" : "\(ageAtStart) bei Reisebeginn")
        }
        if shortWalks { parts.append("kürzere Wege") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

struct TripTravellerSuggestion: Codable, Identifiable, Sendable {
    var id: Int { subjectPersonId }
    let subjectPersonId: Int
    let label: String
    let relation: String
    let birthDate: String?
    let ageAtStart: Int?

    var subtitle: String {
        guard let ageAtStart else { return relation }
        return "\(relation) · \(ageAtStart) bei Reisebeginn"
    }
}
