import SwiftUI

// Day trips as a chip of the spot picker (reise-planen-und-unterwegs.md,
// stage 7, step 3): places half an hour to two hours away that hold a
// day. Choosing one makes a day of the stay a day out, and the picker
// then searches around it for that day. The server finds the places and
// the day to offer (`trip-planner/day-trips.ts`).

struct TripStayDayTripsResponse: Codable, Sendable {
    let targets: [TripDayTripTarget]
    let suggestedDayIndex: Int?
    let searchRadiusM: Double
    let note: String?
}

/// The day the picker adds to while it searches around a destination.
struct TripDayTripFocus: Equatable, Sendable {
    let dayIndex: Int
    let name: String
}

enum TripStayDayTripText {
    /// "ca. 1 h Fahrt · 40 Orte".
    static func line(_ target: TripDayTripTarget) -> String {
        let rounded = max(5, (target.travelMinutes + 2) / 5 * 5)
        let places = target.spotCount == 1 ? "1 Ort" : "\(target.spotCount) Orte"
        return "ca. \(TripClock.duration(rounded)) Fahrt · \(places)"
    }

    /// The day trips the stay already has, in day order.
    static func plannedDays(_ leg: TripLeg) -> [TripDay] {
        leg.days.filter { $0.anchor != nil }.sorted { $0.dayIndex < $1.dayIndex }
    }
}

/// The list behind the chip "Ausflüge".
struct TripStayDayTripsList: View {
    let planId: Int
    let leg: TripLeg
    /// After a day became a day out (or one was picked): search there.
    let choose: (TripDayTripFocus, TripSearchArea) async -> Void

    @State private var response: TripStayDayTripsResponse?
    @State private var loading = false
    @State private var busy: String?
    @State private var errorMessage: String?

    private var radius: Double { response?.searchRadiusM ?? 3_000 }

    var body: some View {
        List {
            let planned = TripStayDayTripText.plannedDays(leg)
            if !planned.isEmpty {
                Section("Schon geplant") {
                    ForEach(planned, id: \.dayIndex) { day in
                        if let anchor = day.anchor {
                            Button {
                                Task {
                                    await choose(TripDayTripFocus(dayIndex: day.dayIndex, name: anchor.label ?? "Ausflug"),
                                                 TripSearchArea(lat: anchor.lat, lon: anchor.lon, radiusM: radius))
                                }
                            } label: {
                                LabeledContent {
                                    Text("Dort suchen")
                                } label: {
                                    Label(anchor.label ?? "Ausflug", systemImage: "car")
                                    Text(TripStayPlan.dayTitle(day, leg: leg))
                                }
                            }
                        }
                    }
                }
            }
            Section {
                if let response {
                    ForEach(response.targets) { target in
                        row(target, suggested: response.suggestedDayIndex)
                    }
                    if response.targets.isEmpty {
                        Text(response.note ?? "Hier ist nichts bekannt.")
                            .foregroundStyle(.secondary)
                    }
                } else if loading {
                    HStack { ProgressView(); Text("Wird geladen…") }
                } else {
                    Text("Die Umgebungssuche antwortet gerade nicht.")
                        .foregroundStyle(.secondary)
                }
                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            } header: {
                Text("Eine halbe bis zwei Stunden entfernt")
            } footer: {
                Text("Übernommen wird der Tag ein Ausflug: Hin- und Rückweg zählen mit, und die Suche zeigt, was dort ist. Langes Drücken wählt einen anderen Tag.")
            }
        }
        .listStyle(.insetGrouped)
        .task(id: leg.position) { await load() }
    }

    private func row(_ target: TripDayTripTarget, suggested: Int?) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: target.symbolName)
                .foregroundStyle(.secondary)
                .frame(width: 44, height: 44)
                .background(Color(.tertiarySystemFill), in: .rect(cornerRadius: 8))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(target.name)
                    .font(.subheadline.weight(.semibold))
                Text(TripStayDayTripText.line(target))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if !target.examples.isEmpty {
                    Text(target.examples.prefix(3).joined(separator: ", "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
            if let day = suggested {
                Button {
                    Task { await accept(target, day: day) }
                } label: {
                    if busy == target.key {
                        ProgressView()
                    } else {
                        Text("+ Tag \(day + 1)")
                            .font(.subheadline.weight(.semibold))
                    }
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .disabled(busy != nil)
                .accessibilityHint("Lange drücken für einen anderen Tag")
            }
        }
        .contextMenu {
            ForEach(leg.days.filter { $0.anchor == nil }.sorted { $0.dayIndex < $1.dayIndex }, id: \.dayIndex) { day in
                Button("Auf \(TripStayPlan.dayTitle(day, leg: leg))", systemImage: "calendar") {
                    Task { await accept(target, day: day.dayIndex) }
                }
            }
            Button("Nicht mehr vorschlagen", systemImage: "hand.raised") {
                Task { await dismiss(target) }
            }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        response = try? await APIClient.shared.get(
            "/trip-planner/plans/\(planId)/legs/\(leg.position)/day-trips")
    }

    private func accept(_ target: TripDayTripTarget, day: Int) async {
        struct Body: Encodable {
            let key: String
            let dayIndex: Int
        }
        guard busy == nil else { return }
        busy = target.key
        defer { busy = nil }
        do {
            let _: TripPlanResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/legs/\(leg.position)/day-trips/accept",
                body: Body(key: target.key, dayIndex: day))
            errorMessage = nil
            await choose(TripDayTripFocus(dayIndex: day, name: target.name),
                         TripSearchArea(lat: target.lat, lon: target.lon, radiusM: radius))
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    private func dismiss(_ target: TripDayTripTarget) async {
        struct Body: Encodable {
            let legIndex: Int
            let key: String
            let name: String
        }
        struct Answer: Decodable {
            let dismissed: Bool
        }
        do {
            let _: Answer = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/day-trip/dismiss",
                body: Body(legIndex: leg.position, key: target.key, name: target.name))
            await load()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }
}
