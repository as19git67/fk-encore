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
                Text("Wer plant mit")
            } footer: {
                // Saying what the role is *for* keeps it from reading as
                // a hierarchy, which §6.2 explicitly does not want.
                Text("Wer die Reise angelegt hat, ändert den Rahmen und lädt ein. "
                     + "Spots beitragen und unterwegs umplanen darf jeder.")
            }

            if model.youOrganise {
                Section("Einladen") {
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
                                .disabled(model.email.trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                    }
                }
            }

            if let errorMessage = model.errorMessage {
                Section {
                    Text(errorMessage).font(.footnote).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Mitreisende")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .refreshable { await model.load() }
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
                    Task { await model.remove(person) }
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

    /// Who is looking. Needed only to label "Verlassen" rather than
    /// "Entfernen" on your own row.
    private(set) var me: Int?

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
            if youOrganise { me = participants.first(where: \.isOrganiser)?.userId }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Everyone may leave; only the organiser may remove somebody else;
    /// nobody may remove the organiser.
    func mayRemove(_ person: TripParticipant) -> Bool {
        if person.isOrganiser { return false }
        return youOrganise || person.userId == me
    }

    func invite() async {
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty else { return }
        isInviting = true
        defer { isInviting = false }
        struct Body: Encodable { let email: String }
        struct Response: Decodable { let added: Bool }
        do {
            let _: Response = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/participants", body: Body(email: address))
            email = ""
            errorMessage = nil
            await load()
        } catch {
            errorMessage = error.localizedDescription
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
            errorMessage = error.localizedDescription
        }
    }
}
