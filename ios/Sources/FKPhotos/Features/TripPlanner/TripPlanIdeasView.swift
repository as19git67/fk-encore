import SwiftUI

/// „Ihr habt vier Ideen für Lissabon gesammelt." (§20.3)
///
/// The bridge from the collection into a trip, and it is deliberately a
/// **question**: an idea from last year is not automatically the wish of
/// this trip, so nothing is taken over by itself.
///
/// Two things it refuses to do. It does not hide what the trip already
/// has — seeing that it is there is the answer to the same question, and
/// a quietly shorter list reads as "not collected" (§20.3). And taking
/// one over does not consume it: the entry stays in the collection,
/// because the next trip to that city will want it too.
struct TripPlanIdeasView: View {
    @State var viewModel: TripPlannerViewModel

    var body: some View {
        List {
            if viewModel.isLoadingPlanIdeas && viewModel.planIdeas.isEmpty {
                HStack { ProgressView(); Text("Wird geladen…") }
            }

            if viewModel.planIdeas.isEmpty && !viewModel.isLoadingPlanIdeas {
                ContentUnavailableView(
                    "Nichts Gesammeltes hier",
                    systemImage: "lightbulb",
                    description: Text("In den Städten dieser Reise liegt nichts aus euren "
                                      + "Ideen."),
                )
            }

            ForEach(legs, id: \.self) { legIndex in
                Section(legTitle(legIndex)) {
                    ForEach(ideas(in: legIndex)) { idea in
                        row(idea)
                    }
                }
            }
        }
        .navigationTitle("Aus den Ideen übernehmen")
        .plannerErrorBanner(viewModel.errorMessage, retry: { await viewModel.loadIdeasForPlan() }, dismiss: { viewModel.errorMessage = nil })
        .task { await viewModel.loadIdeasForPlan() }
        .refreshable { await viewModel.loadIdeasForPlan() }
    }

    /// The city's own name — legs have one, and "Etappe 2" asked the
    /// reader to count.
    private func legTitle(_ legIndex: Int) -> String {
        viewModel.plan?.legs.first { $0.position == legIndex }?.displayTitle ?? "Stadt \(legIndex + 1)"
    }

    private var legs: [Int] {
        Array(Set(viewModel.planIdeas.map(\.legIndex))).sorted()
    }

    private func ideas(in legIndex: Int) -> [TripIdeaForPlan] {
        viewModel.planIdeas
            .filter { $0.legIndex == legIndex }
            .sorted { $0.distanceM < $1.distanceM }
    }

    @ViewBuilder
    private func row(_ idea: TripIdeaForPlan) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(idea.displayName)
                Text(idea.subtitle)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if idea.alreadyInTrip {
                Image(systemName: "checkmark")
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Schon in dieser Reise")
            } else {
                Button("Übernehmen") {
                    Task { await viewModel.takeIdea(idea) }
                }
                .buttonStyle(.bordered)
            }
        }
    }
}
