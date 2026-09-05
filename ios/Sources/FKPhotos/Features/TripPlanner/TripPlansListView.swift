import SwiftUI

/// The user's plans — the way into the planner (§8.1).
///
/// A summary per row rather than the plan itself: a twenty-day trip is
/// hundreds of stops, and choosing between trips needs a name, a length
/// and a date.
struct TripPlansListView: View {
    @State private var plans: [TripPlanSummary] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if isLoading && plans.isEmpty {
                ProgressView("Pläne werden geladen…")
            } else if let errorMessage {
                ContentUnavailableView("Pläne nicht verfügbar", systemImage: "map",
                                       description: Text(errorMessage))
            } else if plans.isEmpty {
                ContentUnavailableView(
                    "Noch keine Reise geplant",
                    systemImage: "map",
                    description: Text("Sag, wohin und wie lange — den Rest schlägt der Planer vor."),
                )
            } else {
                List(plans) { plan in
                    NavigationLink {
                        TripPlanDayView(viewModel: TripPlannerViewModel(planId: plan.id))
                    } label: {
                        row(plan)
                    }
                }
            }
        }
        .navigationTitle("Urlaubsplanung")
        .task { await load() }
        .refreshable { await load() }
    }

    private func row(_ plan: TripPlanSummary) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(plan.displayTitle).font(.headline)
            HStack(spacing: 6) {
                Text(plan.dayCountLabel)
                if let route = plan.routeLabel {
                    Text("·")
                    Text(route).lineLimit(1)
                }
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response: ListTripPlansResponse =
                try await APIClient.shared.get("/trip-planner/plans")
            plans = response.plans
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct ListTripPlansResponse: Codable, Sendable {
    let plans: [TripPlanSummary]
}

struct TripPlanSummary: Codable, Identifiable, Sendable {
    let id: Int
    let title: String?
    /// The legs in order. Entries may be nil — a leg the traveller never
    /// named is still a leg.
    let legTitles: [String?]
    let dayCount: Int
    let startDate: String?
    let updatedAt: String

    /// Falls back to the route, then to a plain label. Never invents a
    /// name for a trip nobody named (§15.3).
    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        if let route = routeLabel { return route }
        return "Reise"
    }

    /// "Beispielstadt → Musterstadt". Nil when no leg has a name.
    var routeLabel: String? {
        let named = legTitles.compactMap { $0 }.filter { !$0.isEmpty }
        return named.isEmpty ? nil : named.joined(separator: " → ")
    }

    var dayCountLabel: String {
        dayCount == 1 ? "1 Tag" : "\(dayCount) Tage"
    }
}
