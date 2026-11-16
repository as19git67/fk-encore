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
    /// The stop with what its stay knows about it: day, time, distance, pin.
    let detailOf: (TripStop) -> TripSpotDetail

    @State private var selection: Int
    @State private var wayStop: TripStop?
    @Environment(\.dismiss) private var dismiss
    @AppStorage(TripMapsPreference.key) private var mapsPreference: String = TripMapsApp.apple.rawValue

    init(stops: [TripStop], selected: TripStop, mode: TripTransportMode,
         onSave: @escaping (TripSpotEdit) async -> Void,
         actions: @escaping (TripStop) -> [TripPinSheetAction],
         way: ((TripStop) -> AnyView?)? = nil,
         stayLight: ((TripStop) -> TripStayLightRef?)? = nil,
         onStayLightAccepted: @escaping () async -> Void = {},
         onCategory: ((String, String) async -> Void)? = nil,
         detailOf: @escaping (TripStop) -> TripSpotDetail = { TripSpotDetail($0) }) {
        self.detailOf = detailOf
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
                    TripSpotDetailView(spot: detailOf(stop), mode: mode, onSave: onSave,
                                       onCategory: onCategory.map { set in { await set(stop.osmRef, $0) } },
                                       stayLight: stayLight?(stop),
                                       onStayLightAccepted: onStayLightAccepted,
                                       onRoute: way == nil ? nil : { wayStop = stop },
                                       bar: .planned(actions(stop)), barOutside: true,
                                       closeAll: { dismiss() }) { _ in EmptyView() }
                    .tag(stop.rowId)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            // The bar under the pages, not on each page: a menu inside
            // the paging scroll view needed two taps, the first one
            // only lit the button up (Anton, 15.11.). One bar for the
            // spot on screen; `id` gives it fresh state per spot.
            .safeAreaInset(edge: .bottom) {
                if let stop = current {
                    bar(for: stop)
                        .id(stop.rowId)
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Schließen", systemImage: "xmark") { dismiss() }
                }
                if stops.count > 1, let index = stops.firstIndex(where: { $0.rowId == selection }) {
                    ToolbarItem(placement: .principal) {
                        Text("\(index + 1) von \(stops.count) an diesem Tag")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
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

    /// The spot the pager shows right now.
    private var current: TripStop? {
        stops.first { $0.rowId == selection } ?? stops.first
    }

    private var preference: TripMapsApp {
        TripMapsApp(rawValue: mapsPreference) ?? .apple
    }

    private func bar(for stop: TripStop) -> some View {
        let detail = detailOf(stop)
        return TripSpotDetailBarView(bar: .planned(actions(stop)), close: { dismiss() }, route: {
            if way != nil {
                wayStop = stop
                return
            }
            let availability = TripMapsAvailability(
                preference: preference, googleAppInstalled: TripMapsOpen.googleInstalled)
            TripMapsOpen.route(TripMapsChoice.single(detail.coordinate, mode: mode),
                               using: availability.resolved ?? .apple)
        }, map: {
            TripMapsOpen.pin(detail.coordinate, name: detail.name, using: preference)
        }, google: {
            TripMapsOpen.pin(detail.coordinate, name: detail.name, using: .google)
        })
    }
}

/// The spot a card opened, with the day it is on.
struct TripStayDetailPick: Identifiable {
    let stop: TripStop
    let dayIndex: Int
    var id: Int { stop.rowId }
}
