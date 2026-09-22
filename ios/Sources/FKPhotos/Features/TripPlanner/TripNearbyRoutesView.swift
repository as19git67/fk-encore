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
/// How far around the city to look for signposted ways (§4.7).
///
/// Three steps rather than a slider, and the reason is what the number
/// means: it is the distance from the leg's anchor to the *nearest
/// point of the way*, and nobody has an opinion about 23 kilometres
/// versus 27. What people do have an opinion about is "around town",
/// "a short drive" and "a day out with the car" — which is what these
/// three are.
///
/// Fifty is the end of the scale because it is the server's limit
/// (`MAX_RADIUS_M` in `routes.ts`, and geo refuses more); offering
/// sixty would be an option that comes back as an error.
enum TripRouteRadius: Int, CaseIterable, Identifiable, Sendable {
    /// What the search did before anybody could choose.
    case standard = 15
    case wider = 25
    case far = 50

    var id: Int { rawValue }
    var km: Int { rawValue }
    var metres: Int { rawValue * 1_000 }
    var label: String { "\(rawValue) km" }

    /// The step a stored number stands for, falling back to the
    /// default: a value from an older build — or a hand-edited one —
    /// should not leave the picker showing nothing.
    static func of(km: Int) -> TripRouteRadius {
        TripRouteRadius(rawValue: km) ?? .standard
    }
}

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
    /// How far to look. The screen owns the choice and remembers it;
    /// the model only carries it into the request.
    var radius: TripRouteRadius = .standard
    /// True when the region holds more ways than the answer carried.
    /// Worth saying, because a wider radius makes it likely.
    private(set) var hasMore = false

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
            var query = [
                "legIndex": String(legIndex),
                "radiusM": String(radius.metres),
            ]
            if !kinds.isEmpty { query["kinds"] = kinds.sorted().joined(separator: ",") }
            let response: TripNearbyRoutesResponse = try await APIClient.shared.get(
                "/trip-planner/plans/\(planId)/routes",
                query: query,
            )
            routes = response.routes
            imported = response.imported
            note = response.note
            hasMore = response.hasMore
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
    /// Carried alongside the model so the course screen can ask for
    /// the file: the export goes through the plan, never through a
    /// region and a relation id somebody names.
    private let planId: Int
    private let legIndex: Int

    /// Remembered per device, because how far somebody is willing to
    /// drive is a habit rather than a decision about one city. Per
    /// viewer and nowhere else: it changes no plan and nobody else's
    /// list.
    @AppStorage("trip.routes.radiusKm") private var radiusKm = TripRouteRadius.standard.km

    init(planId: Int, legIndex: Int) {
        self.planId = planId
        self.legIndex = legIndex
        _model = State(initialValue: TripNearbyRoutesModel(planId: planId, legIndex: legIndex))
    }

    /// The picker's selection, which also reloads.
    ///
    /// Through a binding rather than `onChange`: choosing a radius
    /// *is* asking again, and one place that both stores the choice
    /// and sends the request cannot get out of step with itself.
    private var radius: Binding<TripRouteRadius> {
        Binding(
            get: { TripRouteRadius.of(km: radiusKm) },
            set: { chosen in
                guard chosen.km != radiusKm else { return }
                radiusKm = chosen.km
                model.radius = chosen
                Task { await model.load() }
            },
        )
    }

    var body: some View {
        List {
            Section {
                Picker("Umkreis", selection: radius) {
                    ForEach(TripRouteRadius.allCases) { step in
                        Text(step.label).tag(step)
                    }
                }
                .pickerStyle(.segmented)
                .disabled(model.isLoading)
            } footer: {
                // What the number measures, because it is not the
                // obvious thing: a sixty-kilometre trail that passes
                // eight kilometres from town is in the list, and its
                // start may be a hundred kilometres away.
                Text("Gemessen vom Ausgangspunkt der Etappe bis zur nächsten Stelle "
                     + "der Strecke — nicht bis zu ihrem Anfang.")
            }

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

            // A list that silently stops at forty looks like a region
            // with forty ways in it. Said at the bottom, where the
            // list actually ends (§15.3).
            if model.hasMore {
                Label("Es gibt mehr als diese — gezeigt werden die, die am nächsten "
                      + "vorbeilaufen. Ein kleinerer Umkreis macht die Liste schärfer.",
                      systemImage: "ellipsis.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Strecken in der Nähe")
        .navigationBarTitleDisplayMode(.inline)
        .plannerErrorBanner(model.errorMessage, dismiss: { model.errorMessage = nil })
        .task {
            // The remembered radius has to reach the model before the
            // first request, or the first list would be 15 km and the
            // picker would say 50.
            model.radius = TripRouteRadius.of(km: radiusKm)
            if !model.hasLoaded { await model.load() }
        }
        .refreshable { await model.load() }
    }

    /// Taking the way in, from the course screen — or nothing to do,
    /// because it is already in the pool.
    ///
    /// Written out rather than as a ternary with `nil` on one side: a
    /// closure in a ternary is one of the places Swift's inference
    /// gives up, and the type here is not one anybody should have to
    /// spell twice.
    private func takeAction(for route: TripNearbyRoute) -> (() async -> Void)? {
        if model.isInPool(route) { return nil }
        return { await model.take(route) }
    }

    @ViewBuilder
    private func row(_ route: TripNearbyRoute) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Label {
                    Text(route.name).font(.headline)
                } icon: {
                    Image(systemName: route.symbolName).foregroundStyle(.secondary)
                }
                .fixedSize(horizontal: false, vertical: true)
                .layoutPriority(1)
                Spacer(minLength: 8)
                Text(TripClock.duration(route.estimatedMinutes))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                // Where it runs, one tap away. A row of names is not
                // a decision: two ten-kilometre walks out of the same
                // town are not the same walk, and only the map says
                // which is which.
                NavigationLink {
                    TripRouteCourseView(
                        planId: planId,
                        legIndex: legIndex,
                        route: route,
                        onTake: takeAction(for: route),
                    )
                } label: {
                    Image(systemName: "map").foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("\(route.name) — Verlauf auf der Karte")
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
