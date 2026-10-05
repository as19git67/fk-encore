import SwiftUI

/// One action a screen offers on the spot behind a pin (§5.2).
///
/// The map is a pure function of its inputs and the sheet is layout;
/// what happens to the trip is the one thing neither can compute. So
/// it arrives as a closure from the screen that owns the plan — the
/// day map hands down *ausblenden*, the pool map *einplanen* and
/// *ausblenden* (or *entfernen* on somebody's own find).
struct TripPinSheetAction: Identifiable {
    let id: String
    let title: String
    let systemImage: String
    var role: ButtonRole?
    /// The sentence under the button, where the consequence needs
    /// saying. Nil where the label already says everything.
    var footer: String?
    /// Whether the sheet closes once this has run. Hiding leaves the
    /// sheet describing a spot the trip no longer has; placing takes
    /// the traveller onwards. Both close — but an action that only
    /// marks something would not.
    var closes: Bool = true
    /// Which kind of action it is, so a menu can draw a line between
    /// kinds. The same list is drawn as a menu on the day's rows, as
    /// sections in the detail screen and in the map's sheet — one list,
    /// so no way of looking at a spot can do less than another (§8.4).
    var group: TripSpotActionGroup = .plan
    let run: @MainActor () async -> Void

    init(
        id: String,
        title: String,
        systemImage: String,
        role: ButtonRole? = nil,
        footer: String? = nil,
        closes: Bool = true,
        group: TripSpotActionGroup = .plan,
        run: @escaping @MainActor () async -> Void,
    ) {
        self.id = id
        self.title = title
        self.systemImage = systemImage
        self.role = role
        self.footer = footer
        self.closes = closes
        self.group = group
        self.run = run
    }
}

/// What an action is about, in the order a menu shows them.
enum TripSpotActionGroup: Int, CaseIterable, Comparable {
    /// Done, skipped, open again — what you reach for standing there.
    case status
    /// Getting there, seeing it on a map.
    case navigate
    /// Where it sits in the trip: another block, pinned, the pool.
    case plan
    /// Taking it out of the trip altogether.
    case remove

    static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

/// A spot's actions as the items of a menu, a section per group.
struct TripSpotActionMenuItems: View {
    let actions: [TripPinSheetAction]

    var body: some View {
        ForEach(TripSpotActionGroup.allCases, id: \.self) { group in
            let members = actions.filter { $0.group == group }
            if !members.isEmpty {
                Section {
                    ForEach(members) { action in
                        Button(role: action.role) {
                            Task { await action.run() }
                        } label: {
                            Label(action.title, systemImage: action.systemImage)
                        }
                    }
                }
            }
        }
    }
}

/// A spot's actions as one block of a list — the map's sheet and the
/// detail screen draw them the same way. `close` is called after an
/// action that says it closes, with the screen that shows them.
///
/// One section, not one per action: five actions in five boxes read
/// as five unrelated settings, and the screen was mostly gaps. The
/// sentence an action used to carry as a section footer now sits under
/// its own title inside the row, so the consequence is still said
/// where the finger lands. Rows come in the groups the menu uses, in
/// the same order (§8.4).
struct TripSpotActionSections: View {
    let actions: [TripPinSheetAction]
    var close: @MainActor () -> Void = {}

    @State private var running: String?

    private var ordered: [TripPinSheetAction] {
        // Stable: within a group the caller's order stands.
        actions.enumerated()
            .sorted { ($0.element.group, $0.offset) < ($1.element.group, $1.offset) }
            .map(\.element)
    }

    var body: some View {
        if !actions.isEmpty {
            Section {
                ForEach(ordered) { action in
                    Button(role: action.role) {
                        running = action.id
                        Task {
                            await action.run()
                            running = nil
                            if action.closes { close() }
                        }
                    } label: {
                        if running == action.id {
                            ProgressView()
                        } else {
                            VStack(alignment: .leading, spacing: 2) {
                                Label(action.title, systemImage: action.systemImage)
                                if let footer = action.footer {
                                    Text(footer)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    .disabled(running != nil)
                }
            }
        }
    }
}

/// The popup behind a pin on a trip map (§8.3, §5.2).
///
/// Half a screen, not a whole one: you tapped a dot on a map, so the
/// map must stay visible behind the answer. Everything in it comes from
/// `TripPinDetail`, which is where the question "what may this honestly
/// say" was settled — this file only decides where the lines sit.
///
/// It shows what is there: a stop out of a day brings its number, its
/// block and the way there, a candidate out of the pool brings none of
/// that and the sheet is shorter by exactly those lines.
struct TripPinDetailSheet: View {
    let detail: TripPinDetail
    /// What this pin's screen can do with the spot. Empty where nobody
    /// can act — a shared plan, a preview — and then the buttons are
    /// simply absent instead of failing when pressed.
    var actions: [TripPinSheetAction] = []
    /// The spot itself, for the full detail screen. The sheet used to
    /// be a second, thinner version of it with one action; now it is
    /// the short answer with the long one a tap away.
    var spot: TripSpotDetail? = nil
    var mode: TripTransportMode = .foot
    /// What the detail screen behind "Alle Details" needs to be the
    /// same screen the list opens: somewhere to save a note, the light
    /// and the shelter. Nil where the caller has none.
    var onSave: ((TripSpotEdit) async -> Void)? = nil
    var light: TripSpotLight? = nil
    var shelter: TripSpotShelter? = nil

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            List {
                if let planned = detail.planned {
                    Section {
                        LabeledContent("Wann") {
                            VStack(alignment: .trailing, spacing: 2) {
                                if let blockText = planned.blockText {
                                    Text(blockText)
                                }
                                Text(planned.dwellText).foregroundStyle(.secondary)
                            }
                            .multilineTextAlignment(.trailing)
                        }
                        if let travelText = planned.travelText {
                            LabeledContent("Hinweg", value: travelText)
                        }
                        LabeledContent("Status", value: planned.statusLabel)
                        LabeledContent("Art", value: detail.category)
                        if let extentText = detail.extentText {
                            LabeledContent("Strecke", value: extentText)
                        }
                    }
                } else {
                    Section {
                        LabeledContent("Art", value: detail.category)
                        if let extentText = detail.extentText {
                            LabeledContent("Strecke", value: extentText)
                        }
                    } footer: {
                        // Why the lines above are missing, said once:
                        // an empty sheet reads as a sheet that failed
                        // to load.
                        Text("Noch auf keinem Tag — deshalb steht hier keine Zeit.")
                    }
                }

                if detail.isPhotoStop || detail.planned?.isPinned == true || detail.note != nil {
                    Section {
                        if detail.isPhotoStop {
                            Label("Fotostopp — hierher kommt ihr wegen des Lichts",
                                  systemImage: "camera")
                        }
                        if detail.planned?.isPinned == true {
                            Label("Fester Punkt — bleibt, wo er ist", systemImage: "pin")
                        }
                        if let note = detail.note {
                            Text(note)
                        }
                    }
                }

                // Getting there is this sheet's own "In Karten öffnen"
                // below, and the detail screen's route; the caller's
                // navigation entries would say it twice.
                TripSpotActionSections(actions: actions.filter { $0.group != .navigate },
                                       close: { dismiss() })

                if let spot {
                    Section {
                        NavigationLink {
                            // The same detail screen the list opens, with
                            // the same actions under it: a spot does not
                            // lose what can be done with it by being
                            // reached through the map.
                            TripSpotDetailView(spot: spot, mode: mode, onSave: onSave,
                                               light: light, shelter: shelter) { closeDetail in
                                TripSpotActionSections(
                                    // The detail screen has its own way there.
                                    actions: actions.filter { $0.group != .navigate },
                                    close: { closeDetail(); dismiss() },
                                )
                            }
                        } label: {
                            Label("Alle Details", systemImage: "info.circle")
                        }
                    }
                }

                Section {
                    Button {
                        openURL(mapsURL)
                    } label: {
                        Label("In Karten öffnen", systemImage: "map")
                    }
                    if let wikipediaUrl = detail.wikipediaUrl {
                        // In the app, German or translated (§25, stage C).
                        NavigationLink {
                            TripArticleView(url: wikipediaUrl, placeName: detail.title)
                        } label: {
                            Label("Artikel lesen", systemImage: "book")
                        }
                    }
                    if let sourceUrl = detail.sourceUrl {
                        Link(destination: sourceUrl) {
                            Label("Woher der Fund stammt", systemImage: "link")
                        }
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Fertig") { dismiss() }
                }
            }
            .safeAreaInset(edge: .top) {
                if let localName = detail.localName {
                    // The name on the sign, where it is not the name
                    // above: you are looking for that one when you stand
                    // in front of it (§10.4).
                    Text(localName)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal)
                        .padding(.bottom, 4)
                }
            }
        }
        // Half the screen first, the whole of it on a pull: the long
        // ones (a note, five actions, the article) used to be stuck at
        // half. And the map behind stays bright and usable — the sheet
        // is an answer about a dot on it, not a modal over it; the
        // system's dimming made the whole screen look switched off.
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackgroundInteraction(.enabled(upThrough: .medium))
    }

    /// "7. Kaiserbrunnen" on a day, plain "Kaiserbrunnen" in the pool —
    /// where there is no walking order, there is no number to give.
    private var title: String {
        guard let number = detail.planned?.number else { return detail.title }
        return "\(number). \(detail.title)"
    }

    private var mapsURL: URL {
        TripPinDetail.mapsURL(for: detail)
    }
}
