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
    @State private var isCreating = false
    /// Set to the id of a plan just created, so the list opens it
    /// straight away — nobody makes a trip in order to look at a list.
    @State private var openPlanId: Int?
    /// Something the share sheet left for the planner (§9.2). Peeked
    /// rather than taken, so leaving the screen without confirming does
    /// not lose it.
    @State private var pendingShare: TripSharePayload?
    /// Which plan a pending share is being reviewed against.
    @State private var reviewing: TripShareReview?
    /// The trip a deletion is being confirmed for. Held as the summary
    /// rather than as a flag so the alert can say which one.
    @State private var deleting: TripPlanSummary?

    var body: some View {
        VStack(spacing: 0) {
            if let pendingShare {
                shareBanner(pendingShare)
                Divider()
            }
            content
        }
        .navigationTitle("Urlaubsplanung")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    isCreating = true
                } label: {
                    Label("Neue Reise", systemImage: "plus")
                }
            }
        }
        .sheet(isPresented: $isCreating) {
            NavigationStack {
                TripNewPlanView { planId in
                    openPlanId = planId
                }
            }
        }
        .sheet(item: $reviewing) { review in
            NavigationStack {
                TripShareReviewView(planId: review.planId, payload: review.payload)
            }
        }
        .navigationDestination(item: $openPlanId) { planId in
            TripPlanDayView(viewModel: TripPlannerViewModel(planId: planId))
        }
        .alert("Reise löschen?", isPresented: Binding(
            get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
               presenting: deleting) { plan in
            Button("Löschen", role: .destructive) {
                Task { await delete(plan) }
            }
            Button("Abbrechen", role: .cancel) { deleting = nil }
        } message: { plan in
            Text("„\(plan.displayTitle)“ wird mit allen Tagen, Spots und dem Vorrat gelöscht. "
                 + "Auch für alle, mit denen die Reise geteilt ist.")
        }
        .task {
            await load()
            pendingShare = TripShareInbox.peek()
        }
        .refreshable { await load() }
        .onChange(of: isCreating) { _, nowCreating in
            // The new trip has to appear in the list behind the sheet,
            // not only in the screen that opened on top of it.
            if !nowCreating { Task { await load() } }
        }
        .onChange(of: reviewing) { _, nowReviewing in
            // Taken only once it has actually been offered: a find that
            // was never reviewed should still be there next time.
            if nowReviewing == nil {
                _ = TripShareInbox.take()
                pendingShare = nil
            }
        }
    }

    @ViewBuilder private var content: some View {
        if isLoading && plans.isEmpty {
            ProgressView("Pläne werden geladen…")
        } else if let errorMessage {
            ContentUnavailableView("Pläne nicht verfügbar", systemImage: "map",
                                   description: Text(errorMessage))
        } else if plans.isEmpty {
            ContentUnavailableView {
                Label("Noch keine Reise geplant", systemImage: "map")
            } description: {
                Text("Sag, wohin und wie lange — den Rest schlägt der Planer vor.")
            } actions: {
                // The sentence above promised somewhere to say it. For
                // a while there was nowhere, which left the whole
                // planner unreachable from the app.
                Button("Reise planen") { isCreating = true }
                    .buttonStyle(.borderedProminent)
            }
        } else {
            List(plans) { plan in
                NavigationLink {
                    TripPlanDayView(viewModel: TripPlannerViewModel(planId: plan.id))
                } label: {
                    row(plan)
                }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        // Asked first, and by name. Everything else in
                        // the planner is reversible; this is the one
                        // thing that is not, and it takes the trip away
                        // from everybody it was shared with.
                        deleting = plan
                    } label: {
                        Label("Löschen", systemImage: "trash")
                    }
                }
            }
        }
    }

    /// A find is waiting from the share sheet.
    ///
    /// It asks which trip rather than assuming the first one: a shared
    /// café belongs to the trip you are planning, and with two trips
    /// open there is nothing here that could know which.
    @ViewBuilder private func shareBanner(_ payload: TripSharePayload) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Ein geteilter Fund wartet", systemImage: "link.badge.plus")
                .font(.subheadline.weight(.semibold))
            if let url = payload.url {
                Text(url).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            } else if let text = payload.text {
                Text(text).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            HStack {
                if plans.isEmpty {
                    Text("Erst eine Reise anlegen.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if plans.count == 1, let only = plans.first {
                    Button("Übernehmen") {
                        reviewing = TripShareReview(planId: only.id, payload: payload)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                } else {
                    Menu("Zu welcher Reise?") {
                        ForEach(plans) { plan in
                            Button(plan.displayTitle) {
                                reviewing = TripShareReview(planId: plan.id, payload: payload)
                            }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                }
                Spacer()
                Button("Verwerfen") {
                    TripShareInbox.clear()
                    pendingShare = nil
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.08))
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

    /// Delete a trip (§6.2).
    ///
    /// Only the person who created it may: it goes for everybody it was
    /// shared with, not only for whoever tapped. A companion who simply
    /// wants out leaves through "Mitreisende" and needs nobody's
    /// permission — the server says as much, and the message is shown
    /// rather than swallowed.
    private func delete(_ plan: TripPlanSummary) async {
        deleting = nil
        struct Response: Decodable { let deleted: Bool }
        do {
            let _: Response = try await APIClient.shared.delete(
                "/trip-planner/plans/\(plan.id)")
            plans.removeAll { $0.id == plan.id }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
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

/// A pending share plus the trip it is being reviewed against — one
/// value, so the sheet can be driven by `item:` and cannot be presented
/// without knowing both.
struct TripShareReview: Identifiable, Equatable {
    let planId: Int
    let payload: TripSharePayload

    var id: String { "\(planId)-\(payload.capturedAt.timeIntervalSince1970)" }
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
