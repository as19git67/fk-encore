import SwiftUI

/// The details of a day's spot as a sheet over the day
/// (reise-planen-und-unterwegs.md, stage 4): half height first, pulled
/// up for everything, closed by swiping down, ✕ or "Fertig". Swiping
/// sideways goes to the next spot of the same day.
///
/// The content and the actions are the ones every other surface shows
/// (`TripSpotDetailView`, `stopActions`), so nothing here can do less
/// than the row's "⋯" (CLAUDE.md, "Aktionen an Spots").
struct TripSpotDetailPager: View {
    /// The spots of the day, in its order.
    let stops: [TripStop]
    let mode: TripTransportMode
    let onSave: (TripSpotEdit) async -> Void
    let actions: (TripStop) -> [TripPinSheetAction]
    /// The sheet "Weg" for a spot, opened by "Route hierher" (stage 6);
    /// nil keeps the plain hand-over to the map app.
    let way: ((TripStop) -> AnyView?)?
    /// The stay, so the details can show the evening light (stage 7, step 2).
    let stayLight: ((TripStop) -> TripStayLightRef?)?
    let onStayLightAccepted: () async -> Void
    /// A new kind for a spot ("Art"), by its OSM reference.
    let onCategory: ((String, String) async -> Void)?

    @State private var selection: Int
    @State private var wayStop: TripStop?
    @Environment(\.dismiss) private var dismiss

    init(stops: [TripStop], selected: TripStop, mode: TripTransportMode,
         onSave: @escaping (TripSpotEdit) async -> Void,
         actions: @escaping (TripStop) -> [TripPinSheetAction],
         way: ((TripStop) -> AnyView?)? = nil,
         stayLight: ((TripStop) -> TripStayLightRef?)? = nil,
         onStayLightAccepted: @escaping () async -> Void = {},
         onCategory: ((String, String) async -> Void)? = nil) {
        self.stops = stops.isEmpty ? [selected] : stops
        self.mode = mode
        self.onSave = onSave
        self.actions = actions
        self.way = way
        self.stayLight = stayLight
        self.onStayLightAccepted = onStayLightAccepted
        self.onCategory = onCategory
        _selection = State(initialValue: selected.rowId)
    }

    var body: some View {
        NavigationStack {
            TabView(selection: $selection) {
                ForEach(stops) { stop in
                    TripSpotDetailView(spot: TripSpotDetail(stop), mode: mode, onSave: onSave,
                                       onCategory: onCategory.map { set in { await set(stop.osmRef, $0) } },
                                       stayLight: stayLight?(stop),
                                       onStayLightAccepted: onStayLightAccepted,
                                       onRoute: way == nil ? nil : { wayStop = stop }) { close in
                        TripSpotActionSections(
                            actions: actions(stop).filter { $0.group != .navigate },
                            close: close,
                        )
                    }
                    .tag(stop.rowId)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Schließen", systemImage: "xmark") { dismiss() }
                }
                if stops.count > 1, let index = stops.firstIndex(where: { $0.rowId == selection }) {
                    ToolbarItem(placement: .bottomBar) {
                        Text("\(index + 1) von \(stops.count) an diesem Tag")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fertig") { dismiss() }
                }
            }
        }
        .sheet(item: $wayStop) { stop in
            if let sheet = way?(stop) { sheet }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .opaqueSheetBackground()
    }
}

/// The spot a card opened, with the day it is on.
struct TripStayDetailPick: Identifiable {
    let stop: TripStop
    let dayIndex: Int
    var id: Int { stop.rowId }
}
