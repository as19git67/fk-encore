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
    /// A delete or leave that the server refused. An alert rather than
    /// the list's error state: the list is still perfectly good, and
    /// swapping it for a full-screen error took the way back with it.
    @State private var actionError: String?
    /// The trip the user is about to leave (a companion's "delete").
    @State private var leaving: TripPlanSummary?
    /// "Verwerfen" on the shared find is the one irreversible tap on
    /// this screen that did not ask. Now it does.
    @State private var confirmDiscard = false
    /// A trip-wide screen opened from a row — the evening before, the
    /// week after. They lived only behind a day's "Mehr" menu, which is
    /// the one place nobody is on those days.
    @State private var aux: TripPlanAux?
    @Environment(AuthManager.self) private var authManager
    @State private var isCreating = false
    /// Set to the id of a plan just created, so the list opens it
    /// straight away — nobody makes a trip in order to look at a list.
    @State private var openPlanId: Int?
    /// Something the share sheet left for the planner (§9.2). Peeked
    /// rather than taken, so leaving the screen without confirming does
    /// not lose it.
    @State private var pendingShare: TripSharePayload?
    /// True while the share picker sheet is shown.
    @State private var showingPicker = false
    /// True when the current picker/review session added at least one find to the pool.
    /// Cleared when the sheet is dismissed, so each review starts fresh.
    @State private var reviewAddedAnything = false
    /// The trip a deletion is being confirmed for. Held as the summary
    /// rather than as a flag so the alert can say which one.
    @State private var deleting: TripPlanSummary?
    /// Coming back from the share sheet is not a fresh appearance of
    /// this screen — the app was running the whole time. Without this
    /// the banner only ever showed up on a cold launch, so a find
    /// shared from Apple Maps was announced as "gemerkt" and then
    /// nowhere to be seen.
    @Environment(\.scenePhase) private var scenePhase

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
            // Next to the trips rather than inside one: the collection
            // is the half that exists *without* a trip (§20), and
            // hiding it inside a plan would make it the trip's list.
            ToolbarItem(placement: .topBarLeading) {
                NavigationLink {
                    TripIdeasView()
                } label: {
                    Label("Ideen", systemImage: "lightbulb")
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
        .sheet(isPresented: $showingPicker) {
            if let share = pendingShare {
                TripSharePickerView(payload: share, plans: plans,
                                    didAddAnything: $reviewAddedAnything)
            }
        }
        .navigationDestination(item: $openPlanId) { planId in
            TripPlanDayView(viewModel: TripPlannerViewModel(planId: planId))
        }
        .navigationDestination(item: $aux) { aux in
            switch aux.kind {
            case .readiness:
                TripReadinessView(viewModel: TripPlannerViewModel(planId: aux.planId))
            case .review:
                TripReviewView(planId: aux.planId)
            case .documents:
                TripDocumentsView(planId: aux.planId)
            case .journal:
                TripJournalView(planId: aux.planId)
            case .offline:
                TripOfflineView(viewModel: TripPlannerViewModel(planId: aux.planId))
            }
        }
        .confirmationDialog("Geteilten Fund verwerfen?", isPresented: $confirmDiscard,
                            titleVisibility: .visible) {
            Button("Verwerfen", role: .destructive) {
                TripShareInbox.clear()
                pendingShare = nil
            }
            Button("Abbrechen", role: .cancel) {}
        } message: {
            Text("Der Link ist danach weg. Er lässt sich jederzeit neu teilen.")
        }
        .alert("Das ging nicht", isPresented: Binding(
            get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
            Button("OK", role: .cancel) { actionError = nil }
        } message: {
            Text(actionError ?? "")
        }
        .alert("Reise verlassen?", isPresented: Binding(
            get: { leaving != nil }, set: { if !$0 { leaving = nil } }),
               presenting: leaving) { plan in
            Button("Verlassen", role: .destructive) {
                Task { await leave(plan) }
            }
            Button("Abbrechen", role: .cancel) { leaving = nil }
        } message: { plan in
            Text("„\(plan.displayTitle)“ bleibt für alle anderen bestehen. Du siehst sie "
                 + "danach nicht mehr.")
        }
        .alert("Reise löschen?", isPresented: Binding(
            get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
               presenting: deleting) { plan in
            Button("Löschen", role: .destructive) {
                Task { await delete(plan) }
            }
            Button("Abbrechen", role: .cancel) { deleting = nil }
        } message: { plan in
            Text("„\(plan.displayTitle)“ wird mit allen Tagen, Stopps und Kandidaten gelöscht. "
                 + "Auch für alle, mit denen die Reise geteilt ist.")
        }
        .task {
            await load()
            pendingShare = TripShareInbox.peek()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { pendingShare = TripShareInbox.peek() }
        }
        .refreshable {
            await load()
            pendingShare = TripShareInbox.peek()
        }
        .onChange(of: isCreating) { _, nowCreating in
            // The new trip has to appear in the list behind the sheet,
            // not only in the screen that opened on top of it.
            if !nowCreating { Task { await load() } }
        }
        .onChange(of: showingPicker) { _, nowShowing in
            // Only consume the inbox entry when something was actually added.
            // If the analysis failed or the user just cancelled, the find stays
            // put and the banner reappears, so nothing is lost to a transient
            // problem or a mis-tap.
            if !nowShowing {
                if reviewAddedAnything {
                    _ = TripShareInbox.take()
                    pendingShare = nil
                }
                reviewAddedAnything = false
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
                .contextMenu {
                    Button { aux = TripPlanAux(planId: plan.id, kind: .documents) } label: {
                        Label("Dokumente", systemImage: "doc.text")
                    }
                    Button { aux = TripPlanAux(planId: plan.id, kind: .journal) } label: {
                        Label("Änderungen", systemImage: "arrow.uturn.backward")
                    }
                    Button { aux = TripPlanAux(planId: plan.id, kind: .readiness) } label: {
                        Label("Reisebereit?", systemImage: "checklist")
                    }
                    Button { aux = TripPlanAux(planId: plan.id, kind: .review) } label: {
                        Label("Danach", systemImage: "clock.arrow.circlepath")
                    }
                    Button { aux = TripPlanAux(planId: plan.id, kind: .offline) } label: {
                        Label("Unterwegs ohne Netz", systemImage: "wifi.slash")
                    }
                }
                .swipeActions(edge: .trailing) {
                    if plan.organises {
                        Button(role: .destructive) {
                            // Asked first, and by name. Everything else in
                            // the planner is reversible; this is the one
                            // thing that is not, and it takes the trip away
                            // from everybody it was shared with.
                            deleting = plan
                        } label: {
                            Label("Löschen", systemImage: "trash")
                        }
                    } else {
                        // A companion cannot delete, and the server said
                        // so every time. What they can do is leave.
                        Button(role: .destructive) {
                            leaving = plan
                        } label: {
                            Label("Verlassen", systemImage: "person.badge.minus")
                        }
                    }
                }
            }
        }
    }

    /// A find is waiting from the share sheet.
    @ViewBuilder private func shareBanner(_ payload: TripSharePayload) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Ein geteilter Fund wartet", systemImage: "link.badge.plus")
                .font(.subheadline.weight(.semibold))
            if let title = payload.title, !title.isEmpty {
                Text(title).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            } else if let url = payload.url {
                Text(url).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            } else if let text = payload.text {
                Text(text).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            HStack {
                if plans.isEmpty {
                    // The sentence asked for it; now there is a button.
                    Button("Reise anlegen") { isCreating = true }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                } else {
                    Button("Übernehmen") { showingPicker = true }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                }
                Spacer()
                Button("Verwerfen") { confirmDiscard = true }
                    .buttonStyle(.borderless)
                    .controlSize(.small)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.08))
    }

    private func row(_ plan: TripPlanSummary) -> some View {
        let schedule = plan.schedule(on: Date())
        return VStack(alignment: .leading, spacing: 4) {
            // Which trip you are actually on is said once, by the
            // schedule line below in the accent colour — a second chip
            // said the same thing twice in one cell.
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
            Text(schedule.label)
                .font(.caption)
                .foregroundStyle(schedule.isRunning ? Color.accentColor : .secondary)
            // Time-bound, so offered when the time is: the evening
            // before, and the days after.
            if let prompt = timelyPrompt(for: plan, schedule: schedule) {
                Button {
                    aux = TripPlanAux(planId: plan.id, kind: prompt.kind)
                } label: {
                    Label(prompt.title, systemImage: prompt.systemImage)
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .padding(.top, 2)
            }
        }
        .padding(.vertical, 2)
    }

    private struct TimelyPrompt {
        let title: String
        let systemImage: String
        let kind: TripPlanAux.Kind
    }

    /// "Reisebereit?" in the last two days before departure, "Danach"
    /// for two weeks after the end. Nothing otherwise.
    private func timelyPrompt(for plan: TripPlanSummary, schedule: TripSchedule) -> TimelyPrompt? {
        switch schedule {
        case .upcoming(let days) where days <= 2:
            return TimelyPrompt(title: "Reisebereit?", systemImage: "checklist", kind: .readiness)
        case .past(let days) where days <= 14:
            return TimelyPrompt(title: "Danach: Was war, was nicht", systemImage: "clock.arrow.circlepath",
                                kind: .review)
        default:
            return nil
        }
    }

    /// Delete a trip (§6.2).
    ///
    /// Only the person who created it may: it goes for everybody it was
    /// shared with, not only for whoever tapped. A companion who simply
    /// wants out leaves through "Wer plant mit" and needs nobody's
    /// permission — the server says as much, and the message is shown
    /// rather than swallowed.
    private func delete(_ plan: TripPlanSummary) async {
        deleting = nil
        struct Response: Decodable { let deleted: Bool }
        do {
            let _: Response = try await APIClient.shared.delete(
                "/trip-planner/plans/\(plan.id)")
            plans.removeAll { $0.id == plan.id }
        } catch {
            actionError = TripErrorText.describe(error)
        }
    }

    /// Leave a shared trip (§6.2): the same call the participants
    /// screen makes, for the row you are looking at.
    private func leave(_ plan: TripPlanSummary) async {
        leaving = nil
        guard let me = authManager.currentUser?.id else {
            actionError = "Ohne Anmeldung lässt sich die Reise nicht verlassen."
            return
        }
        struct Body: Encodable { let userId: Int }
        struct Response: Decodable { let removed: Bool }
        do {
            let _: Response = try await APIClient.shared.post(
                "/trip-planner/plans/\(plan.id)/participants/remove", body: Body(userId: me))
            plans.removeAll { $0.id == plan.id }
        } catch {
            actionError = TripErrorText.describe(error)
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
            errorMessage = TripErrorText.describe(error)
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
    /// Whether this user created the trip. Optional so a list from an
    /// older server still decodes; then everybody is treated as the
    /// organiser, which is what the screen did before.
    let youOrganise: Bool?

    var organises: Bool { youOrganise ?? true }

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

/// A trip-wide screen reached from the plan list.
struct TripPlanAux: Hashable, Identifiable {
    enum Kind: Hashable { case readiness, review, documents, journal, offline }
    let planId: Int
    let kind: Kind
    var id: String { "\(planId)-\(kind)" }
}
