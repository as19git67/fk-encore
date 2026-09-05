import MapKit
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
                ContentUnavailableView("Kein Tag geladen", systemImage: "sun.max")
            }
        }
        .navigationTitle("Heute")
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
                        Text("noch \(TripClock.duration(max(0, block.budgetMinutes - block.usedMinutes)))")
                            .foregroundStyle(block.usedMinutes > block.budgetMinutes ? .red : .secondary)
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
            VStack(alignment: .leading, spacing: 2) {
                Text(stop.displayName)
                    .strikethrough(stop.stopStatus != .planned)
                    .foregroundStyle(stop.stopStatus == .planned ? .primary : .secondary)
                Text(TripClock.duration(stop.dwellMinutes))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                offer(.single(stop.coordinate, mode: leg.transportMode))
            } label: {
                Image(systemName: "arrow.triangle.turn.up.right.circle")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Navigation zu \(stop.displayName)")
        }
        .swipeActions(edge: .leading) {
            Button {
                Task { await viewModel.mark(stop, as: .done) }
            } label: {
                Label("Erledigt", systemImage: "checkmark")
            }
            .tint(.green)
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
            googleAppInstalled: UIApplication.shared.canOpenURL(
                URL(string: "\(TripMapsApp.googleScheme)://")!,
            ),
        )
        if let app = availability.resolved {
            open(choice, with: app)
        } else {
            mapsChoice = choice
        }
    }

    private func open(_ choice: TripMapsChoice, with app: TripMapsApp) {
        mapsChoice = nil
        switch app {
        case .apple:
            openInAppleMaps(choice)
        case .google, .ask:
            // The universal URL rather than the scheme: it opens the app
            // when it is there and the browser otherwise, so the choice
            // still works if the scheme check failed for want of an
            // Info.plist entry (§9.1).
            guard let url = TripMapsURL.googleUniversal(
                through: choice.coordinates,
                mode: choice.routeMode,
            ) else { return }
            UIApplication.shared.open(url)
        }
    }

    private func openInAppleMaps(_ choice: TripMapsChoice) {
        let items = choice.coordinates.map { coordinate in
            MKMapItem(placemark: MKPlacemark(
                coordinate: CLLocationCoordinate2D(latitude: coordinate.lat, longitude: coordinate.lon),
            ))
        }
        guard !items.isEmpty else { return }
        MKMapItem.openMaps(with: items, launchOptions: [
            MKLaunchOptionsDirectionsModeKey: choice.routeMode.appleDirectionsMode,
        ])
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
