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
/// Which slice of the map to look in for signposted ways (§4.7).
///
/// A **band**, not a ceiling, and that is the whole point. The answer
/// is ordered by distance and capped at forty, so raising a ceiling
/// alone hands back the same near ways and reports that there are
/// more. Somebody who has worked through what is close needs those
/// *gone*, not outnumbered.
///
/// Three bands rather than a slider, because nobody has an opinion
/// about 23 kilometres versus 27. What people do have an opinion about
/// is "around town", "a short drive" and "a day out with the car".
///
/// The near bands are the narrow ones: ways are dense close to a town
/// and thin out, so equal thirds would leave the first band overfull
/// and the last one empty. Fifty is the end of the scale because it is
/// the server's limit (`MAX_RADIUS_M` in `routes.ts`, and geo refuses
/// more); a fourth band would be an option that comes back as an
/// error.
enum TripRouteBand: Int, CaseIterable, Identifiable, Sendable {
    /// What the search did before bands existed, near enough.
    case near = 20
    case middle = 35
    case far = 50

    var id: Int { rawValue }
    /// The far edge, which is also the stored value.
    var toKm: Int { rawValue }
    var fromKm: Int {
        switch self {
        case .near: return 0
        case .middle: return 20
        case .far: return 35
        }
    }

    var fromMetres: Int { fromKm * 1_000 }
    var toMetres: Int { toKm * 1_000 }

    /// "bis 20 km", "20–35 km". The first band has no near edge worth
    /// naming — "0–20 km" reads like a measurement rather than a
    /// choice.
    var label: String { fromKm == 0 ? "bis \(toKm) km" : "\(fromKm)–\(toKm) km" }

    /// The band a stored number stands for, falling back to the
    /// nearest: a value from an older build — or a hand-edited one —
    /// should not leave the picker showing nothing.
    static func of(km: Int) -> TripRouteBand {
        TripRouteBand(rawValue: km) ?? .near
    }
}

/// Which ways come first (§4.7).
///
/// Two answers to two questions. "What is close" is distance; "what
/// is worth the drive" is what the way passes and how much it matters
/// to its network, which the server weighs over a pool bigger than
/// the page (geo `route-worth.ts`).
enum TripRouteOrder: String, CaseIterable, Identifiable, Sendable {
    case worth
    case distance

    var id: String { rawValue }

    var label: String {
        switch self {
        case .worth: return "Lohnendste zuerst"
        case .distance: return "Nächste zuerst"
        }
    }
}

/// The four kinds of way OpenStreetMap signposts, as the filter shows
/// them (§4.7).
///
/// Worth de-selecting because they are not variations of one thing: a
/// mountain-bike route and a riverside promenade are different days
/// out, and somebody who does not cycle wants the list without them
/// rather than sorted around them.
///
/// The raw values are what the endpoint takes; the labels are what a
/// traveller calls them.
enum TripRouteKind: String, CaseIterable, Identifiable, Sendable {
    case hiking, foot, bicycle, mtb

    var id: String { rawValue }

    var label: String {
        switch self {
        case .hiking: return "Wandern"
        case .foot: return "Spazieren"
        case .bicycle: return "Radfahren"
        case .mtb: return "Mountainbike"
        }
    }

    var symbolName: String {
        switch self {
        case .hiking, .foot: return "figure.hiking"
        case .bicycle, .mtb: return "bicycle"
        }
    }

    /// What the filter says when some kinds are off — the counter on
    /// the button, in words. Nil when everything is shown, because a
    /// filter that changes nothing should not announce itself.
    static func summary(of chosen: Set<String>) -> String? {
        if chosen.isEmpty || chosen.count == allCases.count { return nil }
        let names = allCases.filter { chosen.contains($0.rawValue) }.map(\.label)
        return names.joined(separator: ", ")
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
    /// Which band to look in. The screen owns the choice and
    /// remembers it; the model only carries it into the request.
    var band: TripRouteBand = .near
    /// Which ways come first. Same ownership as the band.
    var order: TripRouteOrder = .worth
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
                "radiusM": String(band.toMetres),
            ]
            // Left out for the first band rather than sent as zero: a
            // request without a near edge is the one every older
            // backend understands.
            if band.fromMetres > 0 { query["minRadiusM"] = String(band.fromMetres) }
            if !kinds.isEmpty { query["kinds"] = kinds.sorted().joined(separator: ",") }
            query["order"] = order.rawValue
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
    ///
    /// A new key rather than the old `radiusKm`: the numbers look
    /// alike but no longer mean the same thing — 50 used to be "up to
    /// 50 km" and is now "35 to 50" — and inheriting that silently
    /// would hide near ways from somebody who never chose to.
    @AppStorage("trip.routes.bandToKm") private var bandToKm = TripRouteBand.near.toKm
    /// Which kinds are shown. Empty means all four, which is also what
    /// the endpoint reads an absent list as.
    @AppStorage("trip.routes.kinds") private var kindsRaw = ""
    /// Which ways come first. Worth by default: somebody opening this
    /// list is choosing, and the nearest is only the easiest.
    @AppStorage("trip.routes.order") private var orderRaw = TripRouteOrder.worth.rawValue

    init(planId: Int, legIndex: Int) {
        self.planId = planId
        self.legIndex = legIndex
        _model = State(initialValue: TripNearbyRoutesModel(planId: planId, legIndex: legIndex))
    }

    /// The picker's selection, which also reloads.
    ///
    /// Through a binding rather than `onChange`: choosing a band *is*
    /// asking again, and one place that both stores the choice and
    /// sends the request cannot get out of step with itself.
    private var band: Binding<TripRouteBand> {
        Binding(
            get: { TripRouteBand.of(km: bandToKm) },
            set: { chosen in
                guard chosen.toKm != bandToKm else { return }
                bandToKm = chosen.toKm
                model.band = chosen
                Task { await model.load() }
            },
        )
    }

    /// The order picker's selection, which also reloads — the same
    /// shape as `band`, for the same reason.
    private var order: Binding<TripRouteOrder> {
        Binding(
            get: { TripRouteOrder(rawValue: orderRaw) ?? .worth },
            set: { chosen in
                guard chosen.rawValue != orderRaw else { return }
                orderRaw = chosen.rawValue
                model.order = chosen
                Task { await model.load() }
            },
        )
    }

    /// The kinds currently shown, read out of the stored string.
    private var chosenKinds: Set<String> {
        Set(kindsRaw.split(separator: ",").map(String.init))
    }

    /// Turn one kind on or off and ask again.
    ///
    /// Turning the last one off would answer with an empty list for a
    /// reason nobody would guess, so it is read as "all of them" —
    /// the same thing the endpoint does with an absent list.
    private func toggle(_ kind: TripRouteKind) {
        var chosen = chosenKinds.isEmpty
            ? Set(TripRouteKind.allCases.map(\.rawValue))
            : chosenKinds
        if chosen.contains(kind.rawValue) {
            chosen.remove(kind.rawValue)
        } else {
            chosen.insert(kind.rawValue)
        }
        if chosen.isEmpty || chosen.count == TripRouteKind.allCases.count {
            kindsRaw = ""
            model.kinds = []
        } else {
            kindsRaw = chosen.sorted().joined(separator: ",")
            model.kinds = chosen
        }
        Task { await model.load() }
    }

    private func showAllKinds() {
        guard !kindsRaw.isEmpty else { return }
        kindsRaw = ""
        model.kinds = []
        Task { await model.load() }
    }

    var body: some View {
        List {
            Section {
                Picker("Entfernung", selection: band) {
                    ForEach(TripRouteBand.allCases) { step in
                        Text(step.label).tag(step)
                    }
                }
                .pickerStyle(.segmented)
                .disabled(model.isLoading)

                Menu {
                    ForEach(TripRouteKind.allCases) { kind in
                        Button {
                            toggle(kind)
                        } label: {
                            Label(kind.label,
                                  systemImage: shows(kind) ? "checkmark" : kind.symbolName)
                        }
                    }
                    if !kindsRaw.isEmpty {
                        Divider()
                        Button("Alle zeigen", systemImage: "arrow.counterclockwise") {
                            showAllKinds()
                        }
                    }
                } label: {
                    LabeledContent("Arten",
                                   value: TripRouteKind.summary(of: chosenKinds) ?? "alle")
                }
                .disabled(model.isLoading)

                Picker("Reihenfolge", selection: order) {
                    ForEach(TripRouteOrder.allCases) { choice in
                        Text(choice.label).tag(choice)
                    }
                }
                .disabled(model.isLoading)
            } footer: {
                // What the number measures, because it is not the
                // obvious thing: a sixty-kilometre trail that passes
                // eight kilometres from town is in the list, and its
                // start may be a hundred kilometres away.
                Text("Gemessen vom Ausgangspunkt der Etappe bis zur nächsten Stelle "
                     + "der Strecke — nicht bis zu ihrem Anfang. Ein weiter entferntes "
                     + "Band zeigt andere Strecken, nicht mehr davon.")
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
                Label(TripRouteOrder(rawValue: orderRaw) == .distance
                      ? "In diesem Band gibt es mehr als diese — gezeigt werden die, die "
                        + "am nächsten vorbeilaufen. Ein Band weiter draußen zeigt die "
                        + "übrigen."
                      : "In diesem Band gibt es mehr als diese — gezeigt werden die "
                        + "lohnendsten unter denen, die am nächsten vorbeilaufen. Ein Band "
                        + "weiter draußen zeigt andere.",
                      systemImage: "ellipsis.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Strecken in der Nähe")
        .navigationBarTitleDisplayMode(.inline)
        .plannerErrorBanner(model.errorMessage, dismiss: { model.errorMessage = nil })
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink {
                    TripRoutesMapView(planId: planId,
                                      legIndex: legIndex,
                                      routes: model.routes)
                } label: {
                    Image(systemName: "map")
                }
                .accessibilityLabel("Alle Strecken auf der Karte")
                .disabled(model.routes.isEmpty)
            }
        }
        .task {
            // The remembered choices have to reach the model before
            // the first request, or the first list would be the
            // default while the controls showed something else.
            model.band = TripRouteBand.of(km: bandToKm)
            model.kinds = chosenKinds
            model.order = TripRouteOrder(rawValue: orderRaw) ?? .worth
            if !model.hasLoaded { await model.load() }
        }
        .refreshable { await model.load() }
    }

    /// Is this kind in the list right now? Nothing chosen means all
    /// four, so every kind shows.
    private func shows(_ kind: TripRouteKind) -> Bool {
        chosenKinds.isEmpty || chosenKinds.contains(kind.rawValue)
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

            // Why it might be worth it, in things rather than stars.
            if let highlights = route.highlightLine {
                Label(highlights, systemImage: "sparkles")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

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
