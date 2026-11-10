import MapKit
import SwiftUI

/// One spot, in full — whether it is planned or still in the pool.
///
/// The two used to be different kinds of thing on screen: a planned stop
/// was a row in a day with a small map button, and a pool candidate was
/// a row you could not touch at all. But "where is that, and why is it
/// on the list?" is the same question in both places, and answering it
/// twice would mean two screens drifting apart — one of them eventually
/// missing the note somebody wrote, or the link the find came from.
///
/// So there is one detail view, and what differs between the two is
/// only which actions the caller offers underneath it.
struct TripSpotDetailView<Actions: View>: View {
    let spot: TripSpotDetail
    /// Which leg this belongs to, for the route's travel mode.
    let mode: TripTransportMode
    /// Where an edit goes. Nil where nothing can take one — a spot
    /// looked up on the map belongs to no leg, and offering a pencil
    /// that saves nowhere is worse than not offering one.
    let onSave: ((TripSpotEdit) async -> Void)?
    /// Where a new kind goes ("Art"). Nil where nothing can take one.
    let onCategory: ((String) async -> Void)?
    /// When the light is good here today (§7.3). A hint and nothing
    /// more: it moves nothing, and it is absent for a trip with no
    /// dates, because there is no sun without a day.
    let light: TripSpotLight?
    /// Whether this spot keeps the rain off (§7.2). Shown next to the
    /// light, because both answer "when should we go".
    let shelter: TripSpotShelter?
    /// The evening light on the days of its stay, with "+ Tag n am
    /// Abend" (stage 7, step 2); nil where the spot is not part of a stay.
    let stayLight: TripStayLightRef?
    let onStayLightAccepted: () async -> Void
    /// The extra actions, built with a way to close this screen.
    ///
    /// An action that removes the spot from the day — hiding it, putting
    /// it back in the pool — leaves this screen describing something
    /// that is no longer there. It has to be able to pop itself, and
    /// only it can: `\.dismiss` read in the *caller* would dismiss the
    /// caller's screen, not this one.
    @ViewBuilder var actions: (@escaping () -> Void) -> Actions

    @Environment(\.dismiss) private var dismiss
    /// Opens the sheet "Weg" instead of handing the route straight to a map app (stage 6).
    let onRoute: (() -> Void)?
    /// The actions as a bar under the sheet (Route · Karte · the one for
    /// the day · Mehr). Nil draws them as rows in the list instead.
    let bar: TripSpotDetailBar?
    @State private var routeChoice: TripMapsChoice?
    /// The pictures of the spot `galleryRef` names: the details can
    /// page to the next spot, and its pictures are not this one's.
    @State private var gallery: [TripRoutePhoto] = []
    @State private var galleryRef: String?
    @State private var editing: TripSpotEdit?
    /// The kind just picked, shown until the caller hands a new spot.
    @State private var shownCategory: String?
    @AppStorage(TripMapsPreference.key) private var mapsPreference: String = TripMapsApp.apple.rawValue

    init(
        spot: TripSpotDetail,
        mode: TripTransportMode = .foot,
        onSave: ((TripSpotEdit) async -> Void)? = nil,
        onCategory: ((String) async -> Void)? = nil,
        light: TripSpotLight? = nil,
        shelter: TripSpotShelter? = nil,
        stayLight: TripStayLightRef? = nil,
        onStayLightAccepted: @escaping () async -> Void = {},
        onRoute: (() -> Void)? = nil,
        bar: TripSpotDetailBar? = nil,
        @ViewBuilder actions: @escaping (@escaping () -> Void) -> Actions,
    ) {
        self.bar = bar
        self.spot = spot
        self.mode = mode
        self.onSave = onSave
        self.onCategory = onCategory
        self.light = light
        self.shelter = shelter
        self.stayLight = stayLight
        self.onStayLightAccepted = onStayLightAccepted
        self.onRoute = onRoute
        self.actions = actions
    }

    var body: some View {
        List {
            // The pictures first, as in the mock (Ablauf 2, step 3): one
            // large, smaller ones beside it, swiped sideways for more.
            TripSpotGallery(photos: galleryRef == spot.osmRef ? gallery : (spot.image.map { [$0] } ?? []))

            header

            // What you need to decide about going (reise-planen-und-unterwegs,
            // mock "Spot-Details"): the ticket, whether it is open, when it
            // is planned, and why somebody saved it.
            planFacts

            // Bilder, Karte, then the text: the order of a way's details,
            // so a spot and a route read alike (Anton, 10.11.).
            Section {
                // Zooms in place, and opens the maps app from its
                // corner (§25, stage B).
                TripSpotMapSnippet(coordinate: spot.coordinate, title: spot.displayName, name: spot.name,
                                   symbolName: TripCategory.symbol(spot.category))
                    .listRowInsets(EdgeInsets())
            }

            // The whole text, where the short sentence above is not all
            // of it (stage 4).
            if let description = spot.description, description.text != spot.summary {
                TripSpotDescriptionSection(description: description)
            }

            contactSection

            if let light, let window = light.best {
                Section {
                    LabeledContent(window.label, value: window.range)
                    if let sentence = light.facadeSentence {
                        Text(sentence)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    if spot.photoStop {
                        // Marked, so the sun had a say in where this
                        // spot landed — said out loud, because a plan
                        // that quietly weighs something is a plan
                        // nobody can argue with (§8.3).
                        Label("Fotostopp — der Planer bevorzugt diesen Ort im guten Licht",
                              systemImage: "camera")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Label("Licht", systemImage: window.symbolName)
                } footer: {
                    // Said once, plainly: the plan stays coarse, and a
                    // minute-precise window inside it is only honest
                    // while nobody treats it as an appointment (§7.3).
                    Text("Ein Hinweis, kein Termin — und ohne Berücksichtigung von "
                         + "Bergen oder Häusern in der Blickrichtung.")
                }
            }

            if let stayLight {
                TripStaySpotLightSection(ref: stayLight, onAccepted: onStayLightAccepted)
            }

            if bar == nil {
                mapLinksSection
                actions({ dismiss() })
            }

            factsSection

            // Last, and deliberately so. It is the one part of this
            // screen nobody opens it for: what the place is, where it
            // is and what you can do with it come first, and the
            // planner's reasoning is what you read afterwards when you
            // disagree with it (§3.8).
            if !spot.reasons.isEmpty {
                Section("Warum hier?") {
                    ForEach(spot.reasons, id: \.self) { reason in
                        Text(reason).font(.callout)
                    }
                }
            }
        }
        // The actions stay at hand at both heights of the sheet, as in
        // the mock: Route, Karte, the one for the day, and the rest
        // under "Mehr".
        .safeAreaInset(edge: .bottom) {
            if let bar {
                TripSpotDetailBarView(bar: bar, close: { dismiss() }, route: { offerRoute() }, map: {
                    TripMapsOpen.pin(spot.coordinate, name: spot.name, using: preference)
                }, google: {
                    TripMapsOpen.pin(spot.coordinate, name: spot.name, using: .google)
                })
            }
        }
        .navigationTitle(spot.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: spot.osmRef) { shownCategory = nil }
        .task(id: spot.osmRef) {
            let ref = spot.osmRef
            let photos = await TripSpotGallery.load(osmRef: ref, image: spot.image)
            guard ref == spot.osmRef else { return }
            gallery = photos
            galleryRef = ref
        }
        .onChange(of: spot.category) { shownCategory = nil }
        .toolbar {
            if onSave != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Bearbeiten", systemImage: "square.and.pencil") {
                        editing = TripSpotEdit(spot)
                    }
                }
            }
        }
        .sheet(item: $editing) { edit in
            NavigationStack {
                TripSpotEditView(edit: edit, spotName: spot.name,
                                 showsPhotoStop: spot.supportsPhotoStop) { saved in
                    editing = nil
                    await onSave?(saved)
                } onCancel: {
                    editing = nil
                }
            }
        }
        .confirmationDialog(
            "Route öffnen mit",
            isPresented: Binding(get: { routeChoice != nil },
                                 set: { if !$0 { routeChoice = nil } }),
            titleVisibility: .visible,
        ) {
            if let choice = routeChoice {
                Button("Apple Karten") { open(choice, with: .apple) }
                Button("Google Maps") { open(choice, with: .google) }
                Button("Immer Apple Karten") {
                    mapsPreference = TripMapsApp.apple.rawValue
                    open(choice, with: .apple)
                }
                Button("Immer Google Maps") {
                    mapsPreference = TripMapsApp.google.rawValue
                    open(choice, with: .google)
                }
                Button("Abbrechen", role: .cancel) {}
            }
        }
    }

    // MARK: - Parts

    /// Name, what it is and how far, the short sentence and the facts: what the
    /// half-height sheet leads with.
    private var header: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(TripSpotName.line(spot.displayName, local: spot.localName))
                    .font(.title3.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                // The short sentence, and whose text it was made from.
                if let summary = spot.summary {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(summary)
                            .font(.callout)
                            .fixedSize(horizontal: false, vertical: true)
                        if let description = spot.description {
                            Text(description.shortSourceLabel)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.top, 2)
                }
                HStack(spacing: 6) {
                    if let pin = spot.pin {
                        TripPinChip(reason: pin.reason, startMinutes: pin.startMinutes)
                    }
                    Text(metaLine)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 4)
        }
    }

    /// "Offen 6–22 · 60 min · Will": the hours only where they fit on
    /// the line; longer ones stand under "Geöffnet" below.
    private var metaLine: String {
        [shortHours.map { "Offen \($0)" }, TripClock.duration(spot.dwellMinutes), spot.priority?.label]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    private var shortHours: String? {
        guard let spec = spot.openingHours, !spec.isEmpty else { return nil }
        let text = TripOpeningHours.display(spec)
        return text.count <= 18 && !text.contains("\n") ? text : nil
    }

    /// "Museum · 1,2 km von Hotel Beispiel".
    private var subtitle: String {
        [TripCategory.label(shownCategory ?? spot.category), spot.distance]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    @ViewBuilder
    private var planFacts: some View {
        let today = spot.openingHours.flatMap { $0.isEmpty ? nil : TripOpeningHours.display($0) }
        let hoursBelow = shortHours == nil ? today : nil
        if spot.ticket != nil || spot.planned != nil || hoursBelow != nil || !(spot.note ?? "").isEmpty {
            Section {
                if let ticket = spot.ticket {
                    LabeledContent("Ticket", value: ticket)
                }
                if let today = hoursBelow {
                    LabeledContent("Geöffnet") {
                        Text(today).multilineTextAlignment(.trailing)
                    }
                }
                if let planned = spot.planned {
                    LabeledContent("Geplant", value: "\(planned) · \(TripClock.duration(spot.dwellMinutes))")
                }
                // Why it was saved beats what it is called, when you are
                // deciding what to do with an afternoon (§9.2).
                if let note = spot.note, !note.isEmpty {
                    LabeledContent("Notiz") {
                        Text(note).multilineTextAlignment(.trailing)
                    }
                }
            }
        }
    }

    /// The place's own website, its article and where the idea came
    /// from ("Notiz und Kontakt" in the mock).
    @ViewBuilder
    private var contactSection: some View {
        let source = spot.sourceUrl.flatMap(URL.init(string:)).flatMap { Self.isMapsURL($0) ? nil : $0 }
        let article = spot.wikipediaUrl.flatMap(URL.init(string:))
        if source != nil || article != nil {
            Section {
                if let article {
                    // In the app, with pictures (§25, stage C): the
                    // German article where one exists, otherwise the
                    // local one and its translation.
                    NavigationLink {
                        TripArticleView(url: article, placeName: spot.displayName)
                    } label: {
                        Label("Wikipedia-Artikel lesen", systemImage: "book")
                    }
                }
                if let source {
                    Link(destination: source) {
                        Label(source.host() ?? source.absoluteString, systemImage: "link")
                    }
                }
            } header: {
                Text("Mehr dazu")
            } footer: {
                // Said before the tap, not after it (§10.4).
                if let article, let language = TripArticleLanguage.name(of: article) {
                    Text("Der Artikel ist auf \(language); gibt es ihn auf Deutsch, "
                         + "wird der gezeigt, sonst übersetzt.")
                }
            }
        }
    }

    /// The map links as rows, for a screen without the bar.
    private var mapLinksSection: some View {
        Section {
            Button {
                TripMapsOpen.pin(spot.coordinate, name: spot.name, using: preference)
            } label: {
                Label("Auf der Karte zeigen", systemImage: "mappin.circle")
            }
            Button {
                // Explicitly the other app, not the preference: this
                // button exists precisely for "I want to look at it
                // over there".
                TripMapsOpen.pin(spot.coordinate, name: spot.name, using: .google)
            } label: {
                Label("In Google Maps öffnen", systemImage: "globe")
            }
            Button {
                offerRoute()
            } label: {
                Label("Route hierher", systemImage: "arrow.triangle.turn.up.right.circle")
            }
        } footer: {
            Text("„Auf der Karte zeigen\u{201D} folgt der App aus den Einstellungen; "
                 + "die Route fragt, wenn dort „jedes Mal fragen\u{201D} steht.")
        }
    }

    private var preference: TripMapsApp {
        TripMapsApp(rawValue: mapsPreference) ?? .apple
    }

    /// What the place is and how long you stay, after what can be done
    /// with it: you open this screen for the place and its actions, and
    /// look these up afterwards.
    @ViewBuilder
    private var factsSection: some View {
        Section {
            // What is written on the building, when it is not what
            // the app just called the place (§10.4). The readable
            // name is the one to plan with and the wrong one to
            // stand in front of a door with.
            if let localName = spot.localName {
                LabeledContent("Vor Ort", value: localName)
            }
            // The map's own name, kept visible under a name the
            // group chose: the ticket desk answers to this one.
            if let official = spot.officialName {
                LabeledContent("In OpenStreetMap", value: official)
            }
            categoryRow
            if let shelter {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text("Bei Regen")
                    Spacer(minLength: 12)
                    Label {
                        Text(shelter.label)
                            .multilineTextAlignment(.trailing)
                    } icon: {
                        Image(systemName: shelter.symbolName)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
            LabeledContent("Aufenthalt", value: TripClock.duration(spot.dwellMinutes))
            if let extent = spot.extent {
                // The way is the point: the day goes on from its end,
                // not from where it starts (§4.7).
                LabeledContent("Strecke", value: extent.summary)
            }
            if spot.name == nil {
                // Said rather than papered over: OpenStreetMap has no
                // name for this, and the app does not invent one
                // (§10.4, §15.3).
                Text("OpenStreetMap kennt für diesen Punkt keinen Namen.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if spot.unmatched {
                Text("Kein OSM-Eintrag zugeordnet — Öffnungszeiten und Kategorie sind unbekannt.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } footer: {
            if !spot.unmatched {
                OSMAttributionNote()
            }
        }

    }

    /// "Art", which the people planning can change where the caller
    /// takes it — the map is sometimes wrong about what a place is.
    @ViewBuilder
    private var categoryRow: some View {
        let category = shownCategory ?? spot.category
        if let onCategory, category != "route" {
            Picker("Art", selection: Binding(
                get: { category },
                set: { picked in
                    guard picked != category else { return }
                    shownCategory = picked
                    Task { await onCategory(picked) }
                },
            )) {
                ForEach(Self.categoryChoices(current: category), id: \.self) { id in
                    Label(TripCategory.label(id), systemImage: TripCategory.symbol(id)).tag(id)
                }
            }
            .pickerStyle(.menu)
        } else {
            LabeledContent("Art", value: TripCategory.label(category))
        }
    }

    /// The kinds to offer, with the current one kept even if it is not
    /// one a person picks, so the menu shows what is set.
    static func categoryChoices(current: String) -> [String] {
        TripCategory.pickable.contains(current) ? TripCategory.pickable : [current] + TripCategory.pickable
    }

    private func offerRoute() {
        if let onRoute {
            onRoute()
            return
        }
        let choice = TripMapsChoice.single(spot.coordinate, mode: mode)
        let availability = TripMapsAvailability(
            preference: preference, googleAppInstalled: TripMapsOpen.googleInstalled)
        if let app = availability.resolved {
            TripMapsOpen.route(choice, using: app)
        } else {
            routeChoice = choice
        }
    }

    private func open(_ choice: TripMapsChoice, with app: TripMapsApp) {
        routeChoice = nil
        TripMapsOpen.route(choice, using: app)
    }

    private static func isMapsURL(_ url: URL) -> Bool {
        guard let host = url.host() else { return false }
        return host == "maps.apple.com"
            || host == "maps.google.com"
            || host.hasSuffix(".google.com") && url.path.hasPrefix("/maps")
    }
}

/// Opened with no actions under it — a spot that belongs to no plan,
/// such as one looked up on the map.
///
/// A constrained extension rather than a default argument: a default
/// value cannot tell the compiler what `Actions` is, so
/// `TripSpotDetailView(spot:)` would not type-check without this.
extension TripSpotDetailView where Actions == EmptyView {
    init(
        spot: TripSpotDetail,
        mode: TripTransportMode = .foot,
        onSave: ((TripSpotEdit) async -> Void)? = nil,
        light: TripSpotLight? = nil,
        shelter: TripSpotShelter? = nil,
    ) {
        self.init(spot: spot, mode: mode, onSave: onSave, light: light, shelter: shelter) { _ in
            EmptyView()
        }
    }
}

/// The actions under a spot's details: one for the day next to Route
/// and Karte, everything else under "Mehr". The same list the row's
/// menu shows (CLAUDE.md, "Aktionen an Spots in der iOS-App").
struct TripSpotDetailBar {
    var primary: TripPinSheetAction?
    /// The short label in the bar ("Anderer Tag", "+ Tag 3").
    var primaryTitle: String?
    /// Its symbol in the bar, where it differs from the menu's.
    var primaryImage: String? = nil
    var more: [TripPinSheetAction]

    /// A planned stop: "Auf einen anderen Tag" goes in the bar. The
    /// navigate group is the bar's own Route and Karte.
    static func planned(_ actions: [TripPinSheetAction]) -> TripSpotDetailBar {
        let shown = actions.filter { $0.group != .navigate }
        let primary = shown.first { $0.id == "move" }
        return TripSpotDetailBar(primary: primary, primaryTitle: primary == nil ? nil : "Anderer Tag",
                                 more: shown.filter { $0.id != primary?.id })
    }
}

/// The bar itself: four equal buttons on the sheet's bottom edge.
struct TripSpotDetailBarView: View {
    let bar: TripSpotDetailBar
    let close: @MainActor () -> Void
    let route: () -> Void
    let map: () -> Void
    let google: () -> Void

    @State private var running: String?

    var body: some View {
        HStack(spacing: 8) {
            button("Route", systemImage: "arrow.triangle.turn.up.right.circle", action: route)
            button("Karte", systemImage: "map", action: map)
            if let primary = bar.primary {
                button(bar.primaryTitle ?? primary.title, systemImage: bar.primaryImage ?? primary.systemImage) { run(primary) }
                    .disabled(running != nil || primary.disabled)
            }
            Menu {
                ForEach(TripSpotActionGroup.allCases, id: \.self) { group in
                    let members = bar.more.filter { $0.group == group }
                    if !members.isEmpty {
                        Section {
                            ForEach(members) { action in
                                Button(role: action.role) { run(action) } label: {
                                    Label(action.title, systemImage: action.systemImage)
                                }
                                .disabled(action.disabled)
                            }
                        }
                    }
                }
                Section {
                    Button(action: google) {
                        Label("In Google Maps öffnen", systemImage: "globe")
                    }
                }
            } label: {
                label("Mehr", systemImage: "ellipsis")
            }
            .buttonStyle(.bordered)
            .disabled(running != nil)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private func button(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            label(title, systemImage: systemImage)
        }
        .buttonStyle(.bordered)
    }

    private func label(_ title: String, systemImage: String) -> some View {
        VStack(spacing: 3) {
            if running != nil && title == bar.primaryTitle {
                ProgressView()
            } else {
                Image(systemName: systemImage)
            }
            Text(title)
                .font(.caption)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, minHeight: 40)
    }

    private func run(_ action: TripPinSheetAction) {
        running = action.id
        Task {
            await action.run()
            running = nil
            if action.closes { close() }
        }
    }
}

/// A spot, flattened out of whichever thing it came from.
///
/// Deliberately a value rather than a protocol over `TripStop` and
/// `TripCandidate`: the detail screen wants the union of what they
/// carry, and a protocol would either force each side to answer
/// questions it has no answer to, or leave the view branching on which
/// one it got — which is the duplication it exists to remove.
struct TripSpotDetail: Identifiable, Sendable {
    let osmRef: String
    let name: String?
    /// What the group calls it, when they have renamed it (§10.4).
    let title: String?
    /// The name on the sign, when `name` is not it (§10.4).
    let localName: String?
    /// The Wikipedia article, where OpenStreetMap knows of one.
    let wikipediaUrl: String?
    let category: String
    let coordinate: TripCoordinate
    let dwellMinutes: Int
    let reasons: [String]
    let note: String?
    let sourceUrl: String?
    let unmatched: Bool
    /// Marked as a spot you come to for the light (§7.3).
    let photoStop: Bool
    /// Whether the flag can be changed here. False for a collected
    /// idea, whose endpoint does not take it yet.
    let supportsPhotoStop: Bool
    /// Where it finishes, when the way is the point (§4.7).
    var extent: TripSpotExtent? = nil
    /// Its picture, where it has one (candidate ranking, stage 2).
    var image: TripRoutePhoto? = nil
    /// What the place is, with its source (candidate ranking, stage 4).
    var description: TripSpotDescription? = nil
    /// One short German sentence about it, made from the description.
    var summary: String? = nil
    /// Muss / Will / Wenn Zeit, for an idea or a planned stop.
    var priority: TripIdeaPriority? = nil
    /// OpenStreetMap's opening_hours, unverified.
    var openingHours: String? = nil
    /// "Mo 7.9. 14:00" when a booked visit holds it.
    var ticket: String? = nil
    /// "Tag 1 · ca. 15:30 bis 17:00", set by the screen that knows the day.
    var planned: String? = nil
    /// The fixed time that holds it, set by the screen that knows the day.
    var pin: TripSpotDetailPin? = nil
    /// "1,2 km vom Hotel", set by the screen that knows the stay.
    var distance: String? = nil

    var id: String { osmRef }
    /// A title the group gave it wins over the map's name: they chose
    /// it precisely so they would recognise the place.
    var displayName: String { title ?? name ?? TripCategory.unnamed(category) }
    /// The map's name, shown underneath a title the group gave it —
    /// renaming a spot here is their shorthand, not a correction of
    /// OpenStreetMap, and the official name is what the ticket desk
    /// answers to.
    var officialName: String? { title == nil ? nil : name }

    init(_ candidate: TripCandidate) {
        osmRef = candidate.osmRef
        name = candidate.name
        title = candidate.title
        localName = candidate.localName
        wikipediaUrl = candidate.wikipediaUrl
        category = candidate.category
        coordinate = candidate.coordinate
        dwellMinutes = candidate.dwellMinutes
        reasons = candidate.reasons
        note = candidate.note
        sourceUrl = candidate.sourceUrl
        unmatched = candidate.unmatched ?? false
        photoStop = candidate.isPhotoStop
        supportsPhotoStop = true
        extent = candidate.extent
        image = candidate.image
        description = candidate.description
        summary = candidate.summary
        priority = candidate.ideaPriority
        openingHours = candidate.openingHours
        ticket = candidate.ticket
    }

    /// A place the browse turned up (§9.2, case 4 widened).
    ///
    /// Nothing here is anybody's yet: no title, no note, no photo stop
    /// — those are things a person adds after deciding to keep it. What
    /// it does carry is why it ranked where it did, which is exactly
    /// what somebody deciding whether to keep it wants to read.
    init(_ found: TripExploredSpot) {
        osmRef = found.osmRef
        name = found.name
        title = nil
        localName = found.localName
        wikipediaUrl = found.wikipediaUrl
        category = found.category
        coordinate = TripCoordinate(lat: found.lat, lon: found.lon)
        dwellMinutes = found.dwellMinutes
        reasons = found.reasons
        note = nil
        sourceUrl = found.website
        // It came out of the region search, so by definition the map
        // knows it.
        unmatched = false
        photoStop = false
        supportsPhotoStop = true
    }

    /// Something already collected (§20).
    ///
    /// The collection's entry is the same place as a planned spot,
    /// before it belongs to a trip — which is why it gets the same
    /// screen rather than a thinner one of its own.
    init(_ idea: TripIdea) {
        osmRef = idea.osmRef
        name = idea.name
        title = idea.title
        localName = nil
        wikipediaUrl = nil
        category = idea.category
        coordinate = TripCoordinate(lat: idea.lat, lon: idea.lon)
        dwellMinutes = idea.dwellMinutes
        // Who collected it, in the place the plan puts its scoring
        // reasons: on the collection that *is* the reason (§20.1).
        reasons = idea.addedBy.map { ["gemerkt von \($0)"] } ?? []
        note = idea.note
        sourceUrl = idea.sourceUrl
        unmatched = idea.unmatched
        photoStop = false
        supportsPhotoStop = false
    }

    init(_ stop: TripStop) {
        osmRef = stop.osmRef
        name = stop.name
        title = stop.title
        localName = stop.localName
        wikipediaUrl = stop.wikipediaUrl
        category = stop.category
        coordinate = stop.coordinate
        dwellMinutes = stop.dwellMinutes
        // The scoring reasons travel with the stop since the server
        // copies them off the pool entry on placement (§8.3). An older
        // server left them there; then the section is empty rather
        // than invented.
        reasons = stop.reasons ?? []
        note = stop.note
        sourceUrl = stop.sourceUrl
        unmatched = false
        photoStop = stop.isPhotoStop
        supportsPhotoStop = true
        extent = stop.extent
        image = stop.image
        description = stop.description
        summary = stop.summary
        priority = stop.ideaPriority
        openingHours = stop.openingHours
    }
}

/// The fixed time a spot has on its day, for the chip in the details.
struct TripSpotDetailPin: Sendable {
    let reason: TripPinReason?
    let startMinutes: Int
}

/// What a stay says about a spot that the spot itself cannot know:
/// which day it is on, when, how far from the bed, and what holds it.
enum TripSpotDetailContext {
    /// "Tag 1 · ca. 15:30 bis 17:00".
    static func planned(_ stop: TripStop, dayIndex: Int) -> String {
        var line = "Tag \(dayIndex + 1)"
        if let eta = stop.etaMinutes {
            line += " · ca. \(TripClock.format(eta)) bis \(TripClock.format(eta + stop.dwellMinutes))"
        }
        return line
    }

    /// "1,2 km vom Hotel Beispiel", "800 m vom Zentrum".
    static func distance(to coordinate: TripCoordinate, in leg: TripLeg) -> String {
        let metres = Int(TripAppleMapsLookup.distance(from: leg.anchor, to: coordinate).rounded())
        let from: String
        if leg.anchorRadiusM != nil {
            from = "vom Zentrum"
        } else if let label = leg.anchorLabel, !label.isEmpty {
            from = "von \(label)"
        } else {
            from = "von der Unterkunft"
        }
        return "\(TripWays.distance(metres)) \(from)"
    }

    /// The stop as the stay's details show it.
    static func detail(_ stop: TripStop, dayIndex: Int?, leg: TripLeg?, pin: TripFixpoint?) -> TripSpotDetail {
        var detail = TripSpotDetail(stop)
        if let dayIndex { detail.planned = planned(stop, dayIndex: dayIndex) }
        if let leg { detail.distance = distance(to: stop.coordinate, in: leg) }
        if let pin { detail.pin = TripSpotDetailPin(reason: pin.reason, startMinutes: pin.startMinutes) }
        return detail
    }
}

extension CLLocationCoordinate2D {
    init(_ coordinate: TripCoordinate) {
        self.init(latitude: coordinate.lat, longitude: coordinate.lon)
    }
}
