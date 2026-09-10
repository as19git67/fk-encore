import SwiftUI

/// "Als Abendtermin einplanen?" (§7.3)
///
/// The one place where the minute-accurate light window may become a
/// time somebody can miss — and only because a person taps. Until then
/// it is a sentence: the terrace this family marked is at its best from
/// about half past eight, the planned day ended at six, and nobody has
/// to do anything about that.
///
/// Accepting makes a fixpoint (§4.4), which is the same call the rest
/// of the app uses for a booked slot or the last train. That is
/// deliberate: an evening appointment is not a new kind of thing, and
/// giving it its own mechanism would mean two places to get the same
/// rule wrong.
struct TripEveningLightView: View {
    let planId: Int
    let legIndex: Int
    let dayIndex: Int
    var onPlanChanged: (() -> Void)?

    @State private var date: String?
    @State private var proposals: [TripEveningProposal] = []
    @State private var isLoading = true
    @State private var busyRef: String?
    @State private var accepted: Set<String> = []
    @State private var errorMessage: String?

    var body: some View {
        List {
            if isLoading && proposals.isEmpty {
                Section { ProgressView() }
            }

            if !isLoading && proposals.isEmpty {
                Section {
                    Text(date == nil
                         ? "Ohne Reisedatum lässt sich der Sonnenstand nicht ausrechnen."
                         : "Heute Abend ist nichts dabei, wofür sich der Weg lohnt.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } footer: {
                    Text("Vorgeschlagen wird nur, was als Fotostopp markiert ist und erst nach "
                         + "dem geplanten Tag im besten Licht liegt.")
                }
            }

            ForEach(proposals) { proposal in
                Section {
                    Text(proposal.sentence).font(.callout)
                    if accepted.contains(proposal.osmRef) {
                        Label("Als Abendtermin eingeplant", systemImage: "checkmark.circle")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        Button {
                            Task { await accept(proposal) }
                        } label: {
                            HStack {
                                Text("Als Abendtermin einplanen")
                                Spacer()
                                if busyRef == proposal.osmRef { ProgressView() }
                            }
                        }
                        .disabled(busyRef != nil)
                    }
                } header: {
                    Label(proposal.label, systemImage: proposal.symbolName)
                } footer: {
                    Text("Bis dahin ist es ein Hinweis. Eine Uhrzeit, die man verpassen kann, "
                         + "entsteht erst mit dem Tippen.")
                }
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).font(.footnote).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Abendlicht")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let answer: TripEveningLight = try await APIClient.shared.get(
                "/trip-planner/plans/\(planId)/light/evening",
                query: [
                    "legIndex": String(legIndex),
                    "dayIndex": String(dayIndex),
                    "utcOffsetMinutes": String(TimeZone.current.secondsFromGMT() / 60),
                ])
            date = answer.date
            proposals = answer.proposals
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func accept(_ proposal: TripEveningProposal) async {
        busyRef = proposal.osmRef
        defer { busyRef = nil }
        do {
            let _: TripPlanResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/fixpoints",
                body: TripEveningFixpointRequest(
                    legIndex: legIndex,
                    dayIndex: dayIndex,
                    label: proposal.label,
                    at: proposal.clockFrom,
                    // The window's own length: an appointment that ends
                    // when the light does, rather than a guess.
                    durationMinutes: max(15, proposal.toMinutes - proposal.fromMinutes)))
            accepted.insert(proposal.osmRef)
            onPlanChanged?()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct TripEveningLight: Codable, Sendable {
    /// Nil when the trip has no dates — then there is no sun to compute.
    let date: String?
    let proposals: [TripEveningProposal]
}

struct TripEveningProposal: Codable, Identifiable, Sendable {
    var id: String { osmRef }
    let osmRef: String
    let label: String
    let from: String
    let to: String
    let fromMinutes: Int
    let toMinutes: Int
    /// golden | blue.
    let kind: String
    let sentence: String
    let lat: Double
    let lon: Double

    /// The window's start in the day's own clock, as the fixpoint call
    /// wants it.
    var clockFrom: String { TripClock.format(fromMinutes) }

    var symbolName: String { kind == "blue" ? "moon.stars" : "sun.horizon" }
}

struct TripEveningFixpointRequest: Encodable, Sendable {
    let legIndex: Int
    let dayIndex: Int
    let label: String
    let at: String
    let durationMinutes: Int
}
