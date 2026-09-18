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
    let run: @MainActor () async -> Void

    init(
        id: String,
        title: String,
        systemImage: String,
        role: ButtonRole? = nil,
        footer: String? = nil,
        closes: Bool = true,
        run: @escaping @MainActor () async -> Void,
    ) {
        self.id = id
        self.title = title
        self.systemImage = systemImage
        self.role = role
        self.footer = footer
        self.closes = closes
        self.run = run
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

    @State private var running: String?
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

                ForEach(actions) { action in
                    Section {
                        Button(role: action.role) {
                            perform(action)
                        } label: {
                            if running == action.id {
                                ProgressView()
                            } else {
                                Label(action.title, systemImage: action.systemImage)
                            }
                        }
                        .disabled(running != nil)
                    } footer: {
                        if let footer = action.footer {
                            Text(footer)
                        }
                    }
                }

                if let spot {
                    Section {
                        NavigationLink {
                            TripSpotDetailView(spot: spot, mode: mode)
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
                        Link(destination: wikipediaUrl) {
                            // With the language where it is not German:
                            // the sheet has one line per link, so it
                            // goes on the label rather than under it
                            // (§10.4).
                            Label(TripArticleLanguage.name(of: wikipediaUrl)
                                    .map { "Wikipedia (\($0))" } ?? "Wikipedia",
                                  systemImage: "book")
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
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }

    /// "7. Kaiserbrunnen" on a day, plain "Kaiserbrunnen" in the pool —
    /// where there is no walking order, there is no number to give.
    private var title: String {
        guard let number = detail.planned?.number else { return detail.title }
        return "\(number). \(detail.title)"
    }

    private func perform(_ action: TripPinSheetAction) {
        running = action.id
        Task {
            await action.run()
            running = nil
            if action.closes { dismiss() }
        }
    }

    private var mapsURL: URL {
        TripPinDetail.mapsURL(for: detail)
    }
}
