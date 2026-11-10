import SwiftUI

/// Everything about one stay, behind a tap on its header (§25): its
/// place and length in the itinerary, and the ways into its ideas, all
/// through the spot picker (reise-planen-und-unterwegs.md, stage 7).
///
/// A journey (§22.7) opens the same sheet. Changing either — its
/// place, its length, its times — happens in the itinerary, the one
/// screen that holds the whole chain, opened on this leg.
struct TripLegSheet: View {
    @State var viewModel: TripPlannerViewModel
    let leg: TripLeg
    @Environment(\.dismiss) private var dismiss
    /// The chip the spot picker opens on, while it is open.
    @State private var picking: TripPickerChip?

    var body: some View {
        List {
            Section {
                NavigationLink {
                    TripItineraryView(viewModel: viewModel, focus: .leg(leg.id))
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
                             ? "Abfahrt, Ankunft und Fortbewegung im Reiseverlauf ändern"
                             : "Unterkunft, Länge und Fortbewegung im Reiseverlauf ändern")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }

            // Every way in is the spot picker (reise-planen-und-unterwegs.md,
            // stage 7, step 5), opened on the chip the row names.
            if leg.position == viewModel.legIndex {
                Section {
                    pickerRow("Spot hinzufügen", systemImage: "plus.circle", chip: .all)
                    pickerRow("Ideen (\(leg.pool.count))", systemImage: "lightbulb.max", chip: .ideas)
                    if !leg.isTransit {
                        pickerRow("Ausflüge", systemImage: "car", chip: .trips)
                    }
                    pickerRow("Strecken", systemImage: "figure.hiking", chip: .routes)
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
                    Text("Ideen")
                } footer: {
                    Text("Alles landet bei den Ideen dieses Aufenthalts oder gleich auf einem Tag.")
                }
            }
        }
        .sheet(item: $picking) { chip in
            TripSpotPickerView(viewModel: viewModel, chip: chip)
        }
        .navigationTitle(leg.isTransit ? "Weiterreise" : "Aufenthalt")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Fertig") { dismiss() }
            }
        }
    }

    private func pickerRow(_ title: String, systemImage: String, chip: TripPickerChip) -> some View {
        Button {
            picking = chip
        } label: {
            Label(title, systemImage: systemImage)
        }
    }
}
