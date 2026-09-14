import SwiftUI

/// Who else is on the trip (§6.2).
///
/// Planning a family holiday alone while everyone watches was the state
/// this replaces: a plan belonged to whoever created it and nobody else
/// could even see it. §6.2 wants the opposite — everyone contributes
/// spots, votes, and re-plans on the road — with three rights held back
/// for one person.
///
/// So the screen is a list of people, not a permission grid. The one
/// distinction it draws is the one that exists: who organises.
struct TripParticipantsView: View {
    @State private var model: TripParticipantsViewModel
    @Environment(AuthManager.self) private var authManager
    @Environment(\.dismiss) private var dismiss
    @State private var confirmLeaving = false
    /// Somebody about to be removed — asked first, by name.
    @State private var removing: TripParticipant?
    /// The participant about to become the organiser (§6.2).
    @State private var handingOverTo: TripParticipant?

    init(planId: Int) {
        _model = State(initialValue: TripParticipantsViewModel(planId: planId))
    }

    var body: some View {
        List {
            Section {
                ForEach(model.participants) { person in
                    row(person)
                }
            } header: {
                Text("Planen mit")
            } footer: {
                // Saying what the role is *for* keeps it from reading as
                // a hierarchy, which §6.2 explicitly does not want.
                Text("Wer die Reise angelegt hat, ändert den Rahmen und lädt ein. "
                     + "Orte beitragen und unterwegs umplanen darf jeder.")
            }

            if model.youOrganise {
                // The household, to pick from — like the album share.
                // Nobody types an address for a person in the same house.
                Section {
                    if let lastInvitation = model.lastInvitation {
                        Label(lastInvitation, systemImage: "checkmark.circle")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    if model.household.isEmpty {
                        Text(model.isLoadingHousehold
                             ? "Wird geladen…"
                             : "Alle aus dem Haushalt planen schon mit.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(model.household) { user in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(user.displayName)
                                Text(user.email).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if model.invitingId == user.id {
                                ProgressView()
                            } else {
                                Button {
                                    Task { await model.invite(user) }
                                } label: {
                                    Image(systemName: "plus.circle")
                                }
                                .buttonStyle(.borderless)
                                .accessibilityLabel("\(user.displayName) mitplanen lassen")
                            }
                        }
                    }
                } header: {
                    Text("Aus dem Haushalt")
                } footer: {
                    Text("Antippen lässt die Person mitplanen. Alle hier haben schon ein Konto; "
                         + "eine Einladung per E-Mail braucht es nicht.")
                }
            }

            if let me = model.participants.first(where: { $0.userId == model.me }),
               !me.isOrganiser {
                // Leaving is a button, not a swipe nobody finds. The
                // plan-list delete dialog sends people here to do it.
                Section {
                    Button(role: .destructive) {
                        confirmLeaving = true
                    } label: {
                        Label("Reise verlassen", systemImage: "person.badge.minus")
                    }
                } footer: {
                    Text("Die Reise bleibt für alle anderen bestehen. Du siehst sie danach "
                         + "nicht mehr.")
                }
            }

        }
        .navigationTitle("Planen mit")
        .plannerErrorBanner(model.errorMessage, retry: { await model.load() }, dismiss: { model.errorMessage = nil })
        .navigationBarTitleDisplayMode(.inline)
        .task {
            model.me = authManager.currentUser?.id
            await model.load()
        }
        .refreshable { await model.load() }
        .confirmationDialog("Aus der Reise entfernen?", isPresented: Binding(
            get: { removing != nil }, set: { if !$0 { removing = nil } }),
            titleVisibility: .visible, presenting: removing) { person in
            Button("\(person.displayName) entfernen", role: .destructive) {
                Task { await model.remove(person) }
            }
            Button("Abbrechen", role: .cancel) {}
        } message: { person in
            Text("\(person.displayName) sieht die Reise danach nicht mehr und kann jederzeit "
                 + "wieder eingeladen werden.")
        }
        .confirmationDialog("Rolle übergeben?", isPresented: Binding(
            get: { handingOverTo != nil }, set: { if !$0 { handingOverTo = nil } }),
            titleVisibility: .visible, presenting: handingOverTo) { person in
            Button("\(person.displayName) organisiert ab jetzt") {
                Task { await model.handOver(to: person) }
            }
            Button("Abbrechen", role: .cancel) {}
        } message: { person in
            Text("\(person.displayName) ändert danach den Rahmen und lädt ein. Du planst "
                 + "weiter mit — wie alle anderen.")
        }
        .confirmationDialog("Reise verlassen?", isPresented: $confirmLeaving,
                            titleVisibility: .visible) {
            Button("Verlassen", role: .destructive) {
                if let me = model.participants.first(where: { $0.userId == model.me }) {
                    Task {
                        await model.remove(me)
                        if model.errorMessage == nil { dismiss() }
                    }
                }
            }
            Button("Abbrechen", role: .cancel) {}
        }
    }

    @ViewBuilder
    private func row(_ person: TripParticipant) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(person.displayName).font(.body)
                Text(person.email).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if person.isOrganiser {
                Text("organisiert").font(.caption).foregroundStyle(.secondary)
            }
        }
        .swipeActions(edge: .trailing) {
            // The organiser cannot be removed: a trip with nobody able
            // to invite anybody back is a dead end.
            if model.mayRemove(person) {
                Button(role: .destructive) {
                    removing = person
                } label: {
                    Label(person.userId == model.me ? "Verlassen" : "Entfernen",
                          systemImage: "person.badge.minus")
                }
            }
            // "Die Rolle ist übertragbar" (§6.2): a swap, so the trip
            // always has exactly one person who can change its frame.
            if model.youOrganise, !person.isOrganiser {
                Button {
                    handingOverTo = person
                } label: {
                    Label("Rolle übergeben", systemImage: "arrow.left.arrow.right")
                }
                .tint(.indigo)
            }
        }
    }
}

struct TripParticipant: Codable, Identifiable, Sendable {
    let userId: Int
    let name: String?
    let email: String
    /// organiser | participant.
    let role: String

    var id: Int { userId }
    var isOrganiser: Bool { role == "organiser" }
    /// Never invented: somebody who set no name shows as their address.
    var displayName: String {
        if let name, !name.isEmpty { return name }
        return email
    }
}

struct TripParticipantsResponse: Codable, Sendable {
    let participants: [TripParticipant]
    let youOrganise: Bool
}

@Observable @MainActor
final class TripParticipantsViewModel {
    private(set) var participants: [TripParticipant] = []
    private(set) var youOrganise = false
    /// Who is being invited right now, for the spinner on that row.
    private(set) var invitingId: Int?
    /// The rest of the household, offered to plan along.
    private(set) var household: [TripHouseholdUser] = []
    private(set) var isLoadingHousehold = false
    var errorMessage: String?

    /// Who is looking — the signed-in user, handed in by the screen.
    /// Used to label "Verlassen" rather than "Entfernen" on your own
    /// row and to offer leaving at all. It used to be derived from the
    /// organiser flag, which left every companion without a way out.
    var me: Int?

    private let planId: Int

    init(planId: Int) {
        self.planId = planId
    }

    func load() async {
        do {
            let response: TripParticipantsResponse = try await APIClient.shared
                .get("/trip-planner/plans/\(planId)/participants")
            participants = response.participants
            youOrganise = response.youOrganise
            errorMessage = nil
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
        if youOrganise { await loadHousehold() }
    }

    /// Everyone may leave; only the organiser may remove somebody else;
    /// nobody may remove the organiser.
    func mayRemove(_ person: TripParticipant) -> Bool {
        if person.isOrganiser { return false }
        return youOrganise || person.userId == me
    }

    /// What the last invitation did, in words.
    private(set) var lastInvitation: String?

    /// The household minus who is already on this trip.
    func loadHousehold() async {
        isLoadingHousehold = true
        defer { isLoadingHousehold = false }
        do {
            let response: TripHouseholdUsersResponse = try await APIClient.shared.get(
                "/trip-planner/shareable-users", query: ["planId": String(planId)])
            household = response.users
        } catch {
            // The list of participants above is the screen; the picker
            // is its second half and may be empty while the first works.
            household = []
            if errorMessage == nil { errorMessage = TripErrorText.describe(error) }
        }
    }

    func invite(_ user: TripHouseholdUser) async {
        invitingId = user.id
        defer { invitingId = nil }
        struct Body: Encodable { let userId: Int }
        struct Response: Decodable { let added: Bool }
        do {
            let response: Response = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/participants", body: Body(userId: user.id))
            lastInvitation = response.added
                ? "\(user.displayName) plant jetzt mit."
                : "\(user.displayName) ist schon dabei."
            errorMessage = nil
            await load()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    func handOver(to person: TripParticipant) async {
        struct Body: Encodable { let userId: Int }
        struct Response: Decodable { let handedOver: Bool }
        do {
            let _: Response = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/participants/hand-over",
                body: Body(userId: person.userId))
            errorMessage = nil
            await load()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    func remove(_ person: TripParticipant) async {
        struct Body: Encodable { let userId: Int }
        struct Response: Decodable { let removed: Bool }
        do {
            let _: Response = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/participants/remove",
                body: Body(userId: person.userId))
            errorMessage = nil
            await load()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }
}
