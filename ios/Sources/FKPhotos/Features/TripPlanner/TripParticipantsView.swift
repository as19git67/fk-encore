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
                Section {
                    if let lastInvitation = model.lastInvitation {
                        Label(lastInvitation, systemImage: "checkmark.circle")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    HStack {
                        TextField("E-Mail-Adresse", text: $model.email)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.emailAddress)
                            .submitLabel(.done)
                            .onSubmit { Task { await model.invite() } }
                        if model.isInviting {
                            ProgressView()
                        } else {
                            Button("Einladen") { Task { await model.invite() } }
                                .buttonStyle(.borderless)
                                .disabled(!model.emailLooksValid)
                        }
                    }
                } header: {
                    Text("Einladen")
                } footer: {
                    Text("Die Adresse, mit der die Person sich anmeldet. Ohne Konto dazu meldet "
                         + "der Server, dass niemand gefunden wurde.")
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
    private(set) var isInviting = false
    var email = ""
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
    }

    /// Everyone may leave; only the organiser may remove somebody else;
    /// nobody may remove the organiser.
    func mayRemove(_ person: TripParticipant) -> Bool {
        if person.isOrganiser { return false }
        return youOrganise || person.userId == me
    }

    /// Enough of a check to catch a typo before the server does: one
    /// "@", something on both sides, a dot after it.
    var emailLooksValid: Bool {
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = address.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty else { return false }
        return parts[1].contains(".") && !parts[1].hasPrefix(".") && !parts[1].hasSuffix(".")
    }

    /// What the last invitation did, in words — the empty field alone
    /// looked the same whether it worked or not.
    private(set) var lastInvitation: String?

    func invite() async {
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard emailLooksValid else { return }
        isInviting = true
        defer { isInviting = false }
        struct Body: Encodable { let email: String }
        struct Response: Decodable { let added: Bool }
        do {
            let response: Response = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/participants", body: Body(email: address))
            if response.added {
                lastInvitation = "\(address) plant jetzt mit."
                email = ""
            } else {
                lastInvitation = "\(address) ist schon dabei."
            }
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
