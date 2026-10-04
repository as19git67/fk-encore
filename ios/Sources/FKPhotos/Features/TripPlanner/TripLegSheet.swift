import SwiftUI

/// Everything about one leg, behind a tap on its header (§25).
///
/// The planner has three levels — the trip, the leg, the day — and the
/// middle one had no place of its own: its candidates, its ballot and
/// its day trips sat in the day screen's menu under "Diese Reise",
/// next to things that really are the trip's. Now the leg's header is
/// the way in, and what opens is only what belongs to this leg: ways
/// to add to its pool, the pool itself, the ballot over it, a day out
/// of it, and the leg's own settings.
///
/// A journey (§22.7) is a leg too: it has a pool of places on the way
/// and a ballot over them, so it opens the same sheet, with its own
/// editor behind "bearbeiten".
struct TripLegSheet: View {
    @State var viewModel: TripPlannerViewModel
    let leg: TripLeg
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            Section {
                NavigationLink {
                    if leg.isTransit {
                        TripTransitView(viewModel: viewModel, afterLegIndex: leg.position - 1, existing: leg)
                    } else {
                        TripLegEditView(viewModel: viewModel, legIndex: leg.position)
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(leg.displayTitle).font(.headline)
                        HStack(spacing: 6) {
                            Label(leg.transportMode.label, systemImage: leg.transportMode.systemImage)
                            if leg.isTransit, let window = leg.transitWindowText {
                                Text("· \(window)")
                            } else if !leg.isTransit {
                                Text("· \(leg.days.count == 1 ? "1 Tag" : "\(leg.days.count) Tage")")
                                if let first = leg.date(ofDayIndex: 0) { Text("· ab \(first)") }
                            }
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        Text(leg.isTransit
                             ? "Abfahrt, Ankunft und Fortbewegung ändern"
                             : "Unterkunft, Länge, Datum und Fortbewegung ändern")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }

            Section {
                // The way into the candidates that needs nothing else —
                // no share sheet, no map app, no model (§9.2, case 4).
                NavigationLink {
                    TripPlaceSearchView(planId: viewModel.planId, legIndex: leg.position)
                } label: {
                    Label("Ort suchen", systemImage: "magnifyingglass")
                }
                // A spot whose way is the point (§4.7): the import knows
                // only points, so it comes by hand.
                NavigationLink {
                    TripRouteEntryView(planId: viewModel.planId, legIndex: leg.position)
                } label: {
                    Label("Strecke anlegen", systemImage: "figure.hiking")
                }
                // What the map already knows (§4.7).
                NavigationLink {
                    TripNearbyRoutesView(planId: viewModel.planId, legIndex: leg.position)
                } label: {
                    Label("Strecken in der Nähe", systemImage: "map")
                }
                // „Ihr habt vier Ideen für Lissabon gesammelt" (§20.3).
                NavigationLink {
                    TripPlanIdeasView(viewModel: viewModel)
                } label: {
                    Label(viewModel.didLoadPlanIdeas
                          ? "Aus den Ideen übernehmen (\(viewModel.pendingIdeas.count))"
                          : "Aus den Ideen übernehmen",
                          systemImage: "lightbulb")
                }
            } header: {
                Text("Hinzufügen")
            } footer: {
                Text("Alles landet im Vorrat dieser Etappe; von dort aus wird in die Tage geplant.")
            }

            Section {
                // Everything this leg could do, and why (§5).
                NavigationLink {
                    TripPoolView(viewModel: viewModel, legIndex: leg.position)
                } label: {
                    Label("Kandidaten (\(leg.pool.count))", systemImage: "tray.full")
                }
                // Everybody rates, nobody is averaged away (§6.1).
                NavigationLink {
                    TripBallotView(planId: viewModel.planId, legIndex: leg.position, leg: leg) {
                        Task { await viewModel.load() }
                    }
                } label: {
                    Label("Wünsche", systemImage: "heart")
                }
                if !leg.isTransit {
                    // „Vier Tage in San Gimignano" — and the city an hour
                    // away (§4.6).
                    NavigationLink {
                        TripDayTripView(planId: viewModel.planId, legIndex: leg.position) {
                            Task { await viewModel.load() }
                        }
                    } label: {
                        Label("Tagesausflug", systemImage: "car")
                    }
                }
            } header: {
                Text("Vorrat")
            }
        }
        .navigationTitle(leg.isTransit ? "Weiterreise" : "Etappe")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Fertig") { dismiss() }
            }
        }
    }
}
