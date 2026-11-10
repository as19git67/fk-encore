import SwiftUI

// Routes as a chip of the spot picker (reise-planen-und-unterwegs.md,
// stage 7, step 4): the signposted ways near the stay, the most
// rewarding first. "+ Tag n" takes one in as an idea (`POST …/routes`,
// which looks it up again) and puts it on the day the server suggests;
// on the day it is a long card with length, climb and "Weg zum Start".
// "Strecke von Hand anlegen" stays for a way the map does not hold.

enum TripStayRoutesText {
    /// "3 h 20 · 10 km · 600 Hm · Rundweg".
    static func line(_ route: TripNearbyRoute) -> String {
        "\(TripClock.duration(route.estimatedMinutes)) · \(route.summary)"
    }

    /// The day a route is on, or nil while it is not planned.
    static func plannedDay(_ osmRef: String, in leg: TripLeg) -> Int? {
        leg.days.first { day in day.blocks.contains { $0.stops.contains { $0.osmRef == osmRef } } }?.dayIndex
    }
}

/// The list behind the chip "Strecken".
struct TripStayRoutesList: View {
    let viewModel: TripPlannerViewModel
    let leg: TripLeg
    /// "Karte" at the top of the picker: every way on one map.
    var showsMap = false

    @State private var routes: [TripNearbyRoute] = []
    @State private var note: String?
    @State private var loaded = false
    @State private var suggestions: [String: TripDaySuggestion] = [:]
    @State private var busy: String?
    @State private var done: [String: String] = [:]
    @State private var shown: TripNearbyRoute?
    @State private var addingByHand = false
    @State private var errorMessage: String?

    private var planId: Int { viewModel.planId }

    var body: some View {
        Group {
            if showsMap && loaded {
                TripRoutesMapView(planId: planId, legIndex: leg.position, routes: routes) { shown = $0 }
            } else {
                list
            }
        }
        .task(id: leg.position) { await load() }
        .sheet(item: $shown) { route in
            NavigationStack {
                TripRouteCourseView(planId: planId, legIndex: leg.position, route: route,
                                    onTake: isTaken(route) ? nil : { await add(route, onDay: nil) })
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Schließen", systemImage: "xmark") { shown = nil }
                        }
                    }
            }
            .presentationDetents([.medium, .large])
            .opaqueSheetBackground()
        }
        .sheet(isPresented: $addingByHand) {
            addByHandSheet
        }
    }

    private var list: some View {
        List {
            Section {
                if !loaded {
                    HStack { ProgressView(); Text("Wird geladen…") }
                } else if routes.isEmpty {
                    Text(note ?? "In der Nähe sind keine Strecken erfasst.")
                        .foregroundStyle(.secondary)
                }
                ForEach(routes) { route in
                    row(route)
                }
                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            } header: {
                Text("Ausgeschilderte Wege in der Nähe")
            } footer: {
                Text("Aus OpenStreetMap, die lohnendsten zuerst. Die Dauer ist geschätzt. Langes Drücken wählt einen anderen Tag.")
            }
            Section {
                Button("Strecke von Hand anlegen", systemImage: "point.topleft.down.to.point.bottomright.curvepath") {
                    addingByHand = true
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private var addByHandSheet: some View {
        NavigationStack {
            TripRouteEntryView(planId: planId, legIndex: leg.position) {
                Task { await viewModel.load() }
            }
        }
        .opaqueSheetBackground()
    }

    private func isTaken(_ route: TripNearbyRoute) -> Bool {
        route.inPool || done[route.osmRef] != nil || leg.pool.contains { $0.osmRef == route.osmRef }
    }

    private func row(_ route: TripNearbyRoute) -> some View {
        let planned = TripStayRoutesText.plannedDay(route.osmRef, in: leg)
        return HStack(alignment: .top, spacing: 10) {
            Button {
                shown = route
            } label: {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: route.symbolName)
                        .foregroundStyle(.secondary)
                        .frame(width: 44, height: 44)
                        .background(Color(.tertiarySystemFill), in: .rect(cornerRadius: 8))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(route.name)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(2)
                        Text(TripStayRoutesText.line(route))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if let highlights = route.highlightLine {
                            Text(highlights)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        if let status = done[route.osmRef] {
                            Label(status, systemImage: "checkmark.circle.fill")
                                .font(.caption)
                                .foregroundStyle(.green)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)

            if let planned {
                Text("Tag \(planned + 1)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 44, minHeight: 32)
            } else {
                let suggestion = suggestions[route.osmRef]
                TripAddButton(running: busy == route.osmRef, full: suggestion?.full == true,
                              label: TripSpotPicker.addLabel(suggestion)) {
                    Task { await add(route, onDay: suggestion?.dayIndex) }
                }
                .disabled(busy != nil)
            }
        }
        .contextMenu {
            if planned == nil {
                ForEach(leg.days.sorted { $0.dayIndex < $1.dayIndex }, id: \.dayIndex) { day in
                    Button("Auf \(TripStayPlan.dayTitle(day, leg: leg))", systemImage: "calendar") {
                        Task { await add(route, onDay: day.dayIndex) }
                    }
                }
                if !isTaken(route) {
                    Button("Als Idee behalten", systemImage: "lightbulb") {
                        Task { await add(route, onDay: nil) }
                    }
                }
            }
        }
    }

    private func load() async {
        defer { loaded = true }
        do {
            let response: TripNearbyRoutesResponse = try await APIClient.shared.get(
                "/trip-planner/plans/\(planId)/routes",
                query: ["legIndex": String(leg.position), "order": "worth"])
            routes = response.routes
            note = response.note
            errorMessage = nil
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
        await suggest()
    }

    private func suggest() async {
        struct Body: Encodable {
            let spots: [TripSuggestSpot]
        }
        let spots = routes
            .filter { TripStayRoutesText.plannedDay($0.osmRef, in: leg) == nil }
            .prefix(60)
            .map { TripSuggestSpot(osmRef: $0.osmRef, dwellMinutes: $0.estimatedMinutes) }
        guard !spots.isEmpty else { return }
        let response: TripDaySuggestionsResponse? = try? await APIClient.shared.post(
            "/trip-planner/plans/\(planId)/legs/\(leg.position)/suggest-day", body: Body(spots: Array(spots)))
        for suggestion in response?.suggestions ?? [] { suggestions[suggestion.osmRef] = suggestion }
    }

    /// Takes the route in as an idea, then onto `day` when one is given.
    private func add(_ route: TripNearbyRoute, onDay day: Int?) async {
        guard busy == nil else { return }
        busy = route.osmRef
        defer { busy = nil }
        do {
            if !isTaken(route) {
                let _: TripTakeRouteResponse = try await APIClient.shared.post(
                    "/trip-planner/plans/\(planId)/routes",
                    body: TripTakeRouteRequest(osmRef: route.osmRef, legIndex: leg.position))
            }
            errorMessage = nil
        } catch {
            errorMessage = TripErrorText.describe(error)
            return
        }
        guard let day else {
            done[route.osmRef] = "bei den Ideen"
            await viewModel.load()
            return
        }
        await viewModel.load()
        guard let target = viewModel.leg?.days.first(where: { $0.dayIndex == day }),
              let block = TripSpotPicker.spotsBlock(of: target)
        else { return }
        if await viewModel.place(osmRef: route.osmRef, inBlock: block.id, onDay: day) {
            done[route.osmRef] = "auf Tag \(day + 1)"
            suggestions = [:]
            await suggest()
        }
    }
}
