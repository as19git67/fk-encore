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
    @ViewBuilder var actions: () -> Actions

    @State private var routeChoice: TripMapsChoice?
    @State private var editing: TripSpotEdit?
    @AppStorage(TripMapsPreference.key) private var mapsPreference: String = TripMapsApp.apple.rawValue

    init(
        spot: TripSpotDetail,
        mode: TripTransportMode = .foot,
        onSave: ((TripSpotEdit) async -> Void)? = nil,
        @ViewBuilder actions: @escaping () -> Actions,
    ) {
        self.spot = spot
        self.mode = mode
        self.onSave = onSave
        self.actions = actions
    }

    var body: some View {
        List {
            Section {
                Map(initialPosition: .region(MKCoordinateRegion(
                    center: CLLocationCoordinate2D(spot.coordinate),
                    latitudinalMeters: 600, longitudinalMeters: 600,
                ))) {
                    Marker(spot.displayName, systemImage: TripCategory.symbol(spot.category),
                           coordinate: CLLocationCoordinate2D(spot.coordinate))
                }
                .frame(height: 180)
                .listRowInsets(EdgeInsets())
                .allowsHitTesting(false)
            }

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
                LabeledContent("Art", value: TripCategory.label(spot.category))
                LabeledContent("Aufenthalt", value: TripClock.duration(spot.dwellMinutes))
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
            }

            // Why it was saved beats what it is called, when you are
            // deciding what to do with an afternoon (§9.2).
            if let note = spot.note, !note.isEmpty {
                Section("Notiz") {
                    Text(note)
                }
            }
            if let source = spot.sourceUrl, let url = URL(string: source) {
                Section("Herkunft") {
                    Link(destination: url) {
                        Label(url.host() ?? source, systemImage: "link")
                    }
                }
            }

            if let article = spot.wikipediaUrl, let url = URL(string: article) {
                Section("Wikipedia") {
                    Link(destination: url) {
                        Label("Artikel lesen", systemImage: "book")
                    }
                }
            }

            if !spot.reasons.isEmpty {
                Section("Warum hier?") {
                    ForEach(spot.reasons, id: \.self) { reason in
                        Text(reason).font(.callout)
                    }
                }
            }

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
                Text("„Auf der Karte zeigen“ folgt der App aus den Einstellungen; "
                     + "die Route fragt, wenn dort „jedes Mal fragen“ steht.")
            }

            actions()
        }
        .navigationTitle(spot.displayName)
        .navigationBarTitleDisplayMode(.inline)
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
                TripSpotEditView(edit: edit, spotName: spot.name) { saved in
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
                Button("Abbrechen", role: .cancel) {}
            }
        }
    }

    private var preference: TripMapsApp {
        TripMapsApp(rawValue: mapsPreference) ?? .apple
    }

    private func offerRoute() {
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
}

/// Opened with no actions under it — a planned stop, where the day view
/// already owns pinning and ticking off.
///
/// A constrained extension rather than a default argument: a default
/// value cannot tell the compiler what `Actions` is, so
/// `TripSpotDetailView(spot:)` would not type-check without this.
extension TripSpotDetailView where Actions == EmptyView {
    init(
        spot: TripSpotDetail,
        mode: TripTransportMode = .foot,
        onSave: ((TripSpotEdit) async -> Void)? = nil,
    ) {
        self.init(spot: spot, mode: mode, onSave: onSave) { EmptyView() }
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
        // The scoring reasons lived on the pool entry, which the
        // placement deleted. An empty section is better than an
        // invented one — and the part that actually matters, why a
        // person saved it, does travel with the stop (§9.2).
        reasons = []
        note = stop.note
        sourceUrl = stop.sourceUrl
        unmatched = false
    }
}

extension CLLocationCoordinate2D {
    init(_ coordinate: TripCoordinate) {
        self.init(latitude: coordinate.lat, longitude: coordinate.lon)
    }
}
