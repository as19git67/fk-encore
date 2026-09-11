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
                    description: Text("In den Etappen dieser Reise liegt nichts aus eurem "
                                      + "Ideenvorrat."),
                )
            }

            ForEach(legs, id: \.self) { legIndex in
                Section("Etappe \(legIndex + 1)") {
                    ForEach(ideas(in: legIndex)) { idea in
                        row(idea)
                    }
                }
            }
        }
        .navigationTitle("Aus dem Vorrat")
        .task { await viewModel.loadIdeasForPlan() }
        .refreshable { await viewModel.loadIdeasForPlan() }
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
