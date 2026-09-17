import SwiftUI

/// "Als Abendtermin einplanen?" (§7.3)
///
/// The one place where the minute-accurate light window may become a
/// time somebody can miss — and only because a person taps. Until then
/// it is a sentence: the terrace this family marked is at its best from
/// about half past eight, the planned day ended at six, and nobody has
/// to do anything about that.
///
/// Accepting frames the day's last block around the spot (§7.3): the
/// block moves to the window, the spot goes into it as a pinned stop,
/// and that block is the one place the outing is shown. It used to be
/// a fixpoint beside the blocks, and the traveller watched two lists
/// for one evening.
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
                        Label("Im Abend-Block eingeplant", systemImage: "checkmark.circle")
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

        }
        .navigationTitle("Abendlicht")
        .plannerErrorBanner(errorMessage, retry: { await load() }, dismiss: { errorMessage = nil })
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
            errorMessage = TripErrorText.describe(error)
        }
    }

    private func accept(_ proposal: TripEveningProposal) async {
        busyRef = proposal.osmRef
        defer { busyRef = nil }
        do {
            // Not an appointment beside the blocks any more: the server
            // frames the day's last block around this spot and puts the
            // spot into it (§7.3). The window is computed again there
            // — a stale proposal cannot frame an evening around light
            // that is gone.
            let _: TripPlanResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/light/evening/accept",
                body: TripEveningAcceptRequest(
                    legIndex: legIndex,
                    dayIndex: dayIndex,
                    osmRef: proposal.osmRef,
                    utcOffsetMinutes: TimeZone.current.secondsFromGMT() / 60))
            accepted.insert(proposal.osmRef)
            onPlanChanged?()
        } catch {
            errorMessage = TripErrorText.describe(error)
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

struct TripEveningAcceptRequest: Encodable, Sendable {
    let legIndex: Int
    let dayIndex: Int
    let osmRef: String
    let utcOffsetMinutes: Int
}
