import SwiftUI

/// Signposted ways near the city, out of OpenStreetMap (§4.7).
///
/// "Strecke anlegen" is the way in that always works: a name, two ends
/// off the device's place search, a duration you estimate yourself. It
/// stays, because the map does not know every path somebody local
/// recommends. But the Ponale, the Sentiero della Pace and most other
/// signposted ways *are* in the map, as relations with their shape,
/// their length and often their climb — and typing those in by hand
/// when the region already holds them is work nobody should do.
///
/// Three things this list says that a name alone would not:
///
///   - **How long it takes**, worked out from the way's own length and
///     climb rather than from a category (§4.7). A starting number: the
///     sheet that takes it in lets you change it.
///   - **Whether it comes back**, because a loop and a way with two
///     ends are planned differently — the day carries on from where a
///     loop began.
///   - **What the region does not know.** A region imported before the
///     planner knew about ways holds none, which is a different answer
///     from "there are none here" and is said as one (§15.3).
@Observable @MainActor
final class TripNearbyRoutesModel {
    private(set) var routes: [TripNearbyRoute] = []
    private(set) var isLoading = false
    private(set) var hasLoaded = false
    /// False when the region predates the route import.
    private(set) var imported = true
    /// Why the list is empty, in the server's words.
    private(set) var note: String?
    private(set) var takingRef: String?
    /// Refs taken in during this visit, so the row can say so at once.
    private(set) var taken: Set<String> = []
    var errorMessage: String?

    /// Which kinds to ask for. Empty means all four.
    var kinds: Set<String> = []

    private let planId: Int
    private let legIndex: Int

    init(planId: Int, legIndex: Int) {
        self.planId = planId
        self.legIndex = legIndex
    }

    func load() async {
        isLoading = true
        defer {
            isLoading = false
            hasLoaded = true
        }
        do {
            var query = ["legIndex": String(legIndex)]
            if !kinds.isEmpty { query["kinds"] = kinds.sorted().joined(separator: ",") }
            let response: TripNearbyRoutesResponse = try await APIClient.shared.get(
                "/trip-planner/plans/\(planId)/routes",
                query: query,
            )
            routes = response.routes
            imported = response.imported
            note = response.note
            errorMessage = nil
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    func take(_ route: TripNearbyRoute) async {
        takingRef = route.osmRef
        defer { takingRef = nil }
        do {
            let _: TripTakeRouteResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/routes",
                body: TripTakeRouteRequest(osmRef: route.osmRef, legIndex: legIndex),
            )
            taken.insert(route.osmRef)
            errorMessage = nil
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    func isInPool(_ route: TripNearbyRoute) -> Bool {
        route.inPool || taken.contains(route.osmRef)
    }
}

struct TripNearbyRoutesView: View {
    @State private var model: TripNearbyRoutesModel

    init(planId: Int, legIndex: Int) {
        _model = State(initialValue: TripNearbyRoutesModel(planId: planId, legIndex: legIndex))
    }

    var body: some View {
        List {
            if model.isLoading && model.routes.isEmpty {
                HStack { ProgressView(); Text("Wird gesucht…") }
            }

            // Not a footnote: a region that was imported before the
            // planner knew about ways is a thing somebody can fix, and
            // an empty list would read as "nothing here".
            if let note = model.note {
                Label(note, systemImage: model.imported ? "info.circle" : "arrow.clockwise.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            ForEach(model.routes) { route in
                row(route)
            }
        }
        .navigationTitle("Strecken in der Nähe")
        .navigationBarTitleDisplayMode(.inline)
        .plannerErrorBanner(model.errorMessage, dismiss: { model.errorMessage = nil })
        .task { if !model.hasLoaded { await model.load() } }
        .refreshable { await model.load() }
    }

    @ViewBuilder
    private func row(_ route: TripNearbyRoute) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Label {
                    Text(route.name).font(.headline)
                } icon: {
                    Image(systemName: route.symbolName).foregroundStyle(.secondary)
                }
                Spacer()
                Text(TripClock.duration(route.estimatedMinutes))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Text(route.summary)
                .font(.caption)
                .foregroundStyle(.secondary)

            // A relation whose members do not join up has no course we
            // can state, so it arrives as a place rather than a way.
            if !route.joined {
                Label("Verlauf in OpenStreetMap unvollständig — kommt ohne Ende an",
                      systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if model.isInPool(route) {
                Label("Bei den Kandidaten", systemImage: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.green)
            } else {
                Button {
                    Task { await model.take(route) }
                } label: {
                    if model.takingRef == route.osmRef {
                        HStack { ProgressView(); Text("Wird übernommen…") }
                    } else {
                        Label("Zu den Kandidaten", systemImage: "plus.circle")
                    }
                }
                .buttonStyle(.borderless)
                .font(.callout)
            }
        }
        .padding(.vertical, 2)
    }
}
