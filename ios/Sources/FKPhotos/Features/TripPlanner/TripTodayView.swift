import SwiftUI

/// The screen that matters while you are out (§8.5): the block you are
/// in, what is still in it, how much budget is left. One big "umplanen"
/// button, and a swipe per spot for done or skipped.
///
/// What it deliberately does *not* do is decide anything. Which block is
/// current, what fits, what a redistribution would move — all of that is
/// the planner's, and this screen asks. The one thing it owns is the
/// handoff to a map app, because that is the one thing the server cannot
/// do (§9.1).
struct TripTodayView: View {
    @State var viewModel: TripPlannerViewModel
    @State private var mapsChoice: TripMapsChoice?
    @AppStorage(TripMapsPreference.key) private var mapsPreference: String = TripMapsApp.apple.rawValue

    var body: some View {
        Group {
            if let day = viewModel.day, let leg = viewModel.leg {
                content(day: day, leg: leg)
            } else {
                ContentUnavailableView(
                    "Kein Tag geladen",
                    systemImage: "figure.walk",
                    description: Text("Diese Ansicht ist die für unterwegs: der Block, in dem "
                                      + "ihr gerade steckt, was davon noch aussteht, und "
                                      + "„Umplanen“, wenn es anders kommt."),
                )
            }
        }
        .navigationTitle("Unterwegs")
        .navigationBarTitleDisplayMode(.inline)
        .task { await viewModel.load() }
        .confirmationDialog(
            "Navigation öffnen mit",
            isPresented: Binding(get: { mapsChoice != nil }, set: { if !$0 { mapsChoice = nil } }),
            titleVisibility: .visible,
        ) {
            if let choice = mapsChoice {
                Button("Apple Karten") { open(choice, with: .apple) }
                Button("Google Maps") { open(choice, with: .google) }
                Button("Abbrechen", role: .cancel) {}
            }
        }
    }

    @ViewBuilder
    private func content(day: TripDay, leg: TripLeg) -> some View {
        List {
            Section {
                Button {
                    Task { await viewModel.redistributeNow() }
                } label: {
                    if viewModel.isRedistributing {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    } else {
                        Label("Umplanen", systemImage: "arrow.triangle.2.circlepath")
                            .frame(maxWidth: .infinity)
                            .font(.headline)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(viewModel.isRedistributing || !day.detailed)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)

                if let reason = viewModel.redistributeBlockedReason {
                    // Why it did not run, in words that say what to do
                    // about it — never a silent no-op.
                    Text(reason)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if !viewModel.displaced.isEmpty {
                    // What lost its place. A count would not be
                    // reviewable; the names are (§5).
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Zurück in den Vorrat:").font(.footnote.weight(.semibold))
                        ForEach(viewModel.displaced) { stop in
                            Text("· \(stop.displayName)").font(.footnote)
                        }
                    }
                    .foregroundStyle(.secondary)
                }
            }

            if !day.detailed {
                Section {
                    Text("Dieser Tag ist noch nicht im Detail geplant.")
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(day.blocks) { block in
                Section {
                    if block.stops.isEmpty {
                        Text(block.isMeal
                             ? "Zeit fürs Essen — der Planer sucht kein Lokal aus."
                             : "Nichts geplant.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(block.stops) { stop in
                        stopRow(stop, leg: leg)
                    }
                } header: {
                    HStack {
                        Text(block.label)
                        Spacer()
                        Text(block.usedMinutes > block.budgetMinutes
                             ? "\(TripClock.duration(block.usedMinutes - block.budgetMinutes)) zu viel"
                             : "noch \(TripClock.duration(block.budgetMinutes - block.usedMinutes))")
                            .foregroundStyle(
                                block.usedMinutes > block.budgetMinutes
                                    || viewModel.overfullBlockIds.contains(block.id)
                                    ? .red : .secondary,
                            )
                    }
                } footer: {
                    if block.isMeal {
                        // The planner framed the meal and stopped there
                        // (§10.3, stage 1). Finding somewhere is stage
                        // two, and it happens here, on the spot.
                        NavigationLink {
                            TripFoodListView(position: leg.anchor)
                        } label: {
                            Label("Essen in der Nähe", systemImage: "fork.knife")
                                .font(.footnote)
                        }
                        .padding(.top, 4)
                    }
                    if !block.stops.isEmpty {
                        Button {
                            // The whole block at once: Apple takes an
                            // array of destinations and Google knows
                            // waypoints, so the morning walks over in
                            // one piece rather than a leg at a time.
                            offer(.block(block.stops.map(\.coordinate), mode: leg.transportMode))
                        } label: {
                            Label("Ganzen Block in Karten öffnen", systemImage: "arrow.triangle.turn.up.right.diamond")
                                .font(.footnote)
                        }
                        .buttonStyle(.plain)
                        .padding(.top, 4)
                    }
                }
            }
        }
    }

    private func stopRow(_ stop: TripStop, leg: TripLeg) -> some View {
        HStack(spacing: 10) {
            // The same detail screen the pool and the day view open.
            NavigationLink {
                // Editable here too: "Eingang um die Ecke" is learned
                // standing in front of the door, not at the planning
                // table (§9.2).
                TripSpotDetailView(
                    spot: TripSpotDetail(stop),
                    mode: leg.transportMode,
                    onSave: { await viewModel.saveNote($0) },
                )
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(stop.displayName)
                        .strikethrough(stop.stopStatus != .planned)
                        .foregroundStyle(stop.stopStatus == .planned ? .primary : .secondary)
                    Text(TripClock.duration(stop.dwellMinutes))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)
            Spacer()
            // Routing somewhere is only useful once you are travelling.
            // Planning at the kitchen table, the same tap should answer
            // "where is that?" — a route from home to a café you will
            // walk to next month is a number nobody wants.
            Button {
                if isTravelling {
                    offer(.single(stop.coordinate, mode: leg.transportMode))
                } else {
                    showOnMap(stop)
                }
            } label: {
                Image(systemName: isTravelling
                      ? "arrow.triangle.turn.up.right.circle"
                      : "mappin.circle")
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isTravelling
                                ? "Navigation zu \(stop.displayName)"
                                : "\(stop.displayName) auf der Karte zeigen")
        }
        .swipeActions(edge: .leading) {
            Button {
                Task { await viewModel.mark(stop, as: .done) }
            } label: {
                Label("Erledigt", systemImage: "checkmark")
            }
            .tint(.green)

            Button {
                Task { await viewModel.setPinned(stop, !stop.pinned) }
            } label: {
                Label(stop.pinned ? "Lösen" : "Anheften", systemImage: stop.pinned ? "pin.slash" : "pin")
            }
            .tint(.orange)
        }
        .contextMenu {
            // Dragging is the gesture the concept names, but a menu is
            // what makes the same move reachable one-handed and with
            // VoiceOver — and it is the only way to reach another day.
            if let leg = viewModel.leg {
                ForEach(leg.days.filter(\.detailed)) { target in
                    Menu(target.dayIndex == viewModel.dayIndex
                         ? "In diesem Tag verschieben"
                         : "Auf Tag \(target.dayIndex + 1) verschieben") {
                        ForEach(target.blocks.filter { !$0.isMeal }) { block in
                            Button(block.label) {
                                Task {
                                    await viewModel.move(
                                        stop,
                                        toDayIndex: target.dayIndex,
                                        toBlockId: block.id,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
        .swipeActions(edge: .trailing) {
            Button {
                Task { await viewModel.mark(stop, as: .skipped) }
            } label: {
                Label("Übersprungen", systemImage: "xmark")
            }
            .tint(.orange)
        }
    }

    // MARK: - Handoff

    private func offer(_ choice: TripMapsChoice) {
        let availability = TripMapsAvailability(
            preference: TripMapsApp(rawValue: mapsPreference) ?? .apple,
            googleAppInstalled: TripMapsOpen.googleInstalled,
        )
        if let app = availability.resolved {
            TripMapsOpen.route(choice, using: app)
        } else {
            mapsChoice = choice
        }
    }

    private func open(_ choice: TripMapsChoice, with app: TripMapsApp) {
        mapsChoice = nil
        TripMapsOpen.route(choice, using: app)
    }

    /// Is a trip actually running?
    ///
    /// Trip mode is what knows: it is the thing that gets started when
    /// you set off. The planner deliberately keeps out of that decision
    /// rather than guessing from dates — a trip planned for July and a
    /// trip you are on are different states, and only one of them
    /// wants turn-by-turn.
    private var isTravelling: Bool { TripStore.shared.isActive }

    /// Show the spot, without a route.
    ///
    /// The same map app the traveller chose for everything else (§9.1):
    /// the setting is about which app, not about which question.
    private func showOnMap(_ stop: TripStop) {
        TripMapsOpen.pin(stop.coordinate, name: stop.name,
                         using: TripMapsPreference.load())
    }
}

/// What is being handed over: one stop, or a whole block at once.
enum TripMapsChoice: Identifiable {
    case single(TripCoordinate, mode: TripTransportMode)
    case block([TripCoordinate], mode: TripTransportMode)

    var id: String {
        coordinates.map(TripMapsURL.coordinate).joined(separator: "|")
    }

    var coordinates: [TripCoordinate] {
        switch self {
        case let .single(c, _):  return [c]
        case let .block(cs, _):  return cs
        }
    }

    var routeMode: TripRouteMode {
        switch self {
        case let .single(_, mode), let .block(_, mode): return TripRouteMode(mode)
        }
    }
}
