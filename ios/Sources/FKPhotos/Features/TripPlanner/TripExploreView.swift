import SwiftUI

/// Recherche in der App: what is here, before there is a trip (§9.2, §20).
///
/// The four ways into the pool all assume the research already
/// happened — a link from a map app, an article, a screenshot, a name
/// you type. This is the step before: *what is here at all?* The region
/// databases have been able to answer it since the first import, and
/// only the solver ever asked.
///
/// **It works without a trip.** The area comes from the phone or from a
/// place picked out of Apple's geocoder, and what is found goes into
/// the idea collection, which has never needed a journey (§20).
/// Collecting in March for a holiday booked in July is the ordinary
/// case, not the exotic one.
///
/// **A tap is the query.** Interests are chips and the list fills with
/// no text typed at all. The name filter is still there — it is the way
/// in that has to work when nothing else does — but it lives in the
/// navigation bar now, where iOS puts one.
///
/// The first draft put all of that *into the list*: the location
/// button, the place field, the name field and the results, as rows of
/// one form. That reads as a settings screen and it is not what the
/// platform does — a list of results has a search field above it, not
/// among it. So the query lives in `.searchable`, the filters ride
/// under the navigation bar, choosing the area is a sheet, and the list
/// holds nothing but what was found.
///
/// **An empty list says which kind of empty it is.** A region nobody
/// imported, a filter too narrow, and an area with nothing in it are
/// three different answers, and the server names which one this is.
struct TripExploreView: View {
    @State private var model = TripExploreViewModel()
    @State private var isPickingArea = false
    @State private var isReadingArticle = false
    @State private var opened: TripExploredSpot?
    /// Which collection a find goes into. Nil means one's own.
    let ownerId: Int?

    init(ownerId: Int? = nil) {
        self.ownerId = ownerId
    }

    var body: some View {
        List {
            if let message = model.lastAddition {
                Text(message).font(.footnote).foregroundStyle(.secondary)
            }
            // Said rather than left blank: the three kinds of empty are
            // three different things to do next.
            if let note = model.note, model.spots.isEmpty {
                Text(note).foregroundStyle(.secondary)
            }
            // And the one of the three that a person can do something
            // about gets the something. Creating a trip has asked for
            // the maps on the traveller's behalf since the planner
            // existed; a browse hits the same wall and may as well
            // offer the same way through it.
            if model.regionMissing {
                if let note = model.regionNote {
                    Text(note).font(.footnote).foregroundStyle(.secondary)
                } else {
                    Button {
                        Task { await model.requestRegion() }
                    } label: {
                        Label(model.isRequestingRegion
                              ? "Wird angefragt\u{2026}" : "Karten f\u{00FC}r diese Gegend holen",
                              systemImage: "square.and.arrow.down")
                            .frame(minHeight: 44)
                    }
                    .disabled(model.isRequestingRegion)
                }
            }

            ForEach(model.spots) { spot in
                Button { opened = spot } label: { row(spot) }
                    .buttonStyle(.plain)
            }

            if model.hasMore {
                Text("Es gibt mehr — enger eingrenzen hilft.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .listStyle(.plain)
        // The name filter belongs in the navigation bar, not in a row
        // of the list it filters.
        .searchable(text: $model.query, prompt: "Name des Ortes")
        .onSubmit(of: .search) { Task { await model.load() } }
        // The chips sit between the bar and the list, which is where a
        // filter belongs — inside the list they scrolled away with the
        // results they were filtering.
        .safeAreaInset(edge: .top) {
            if model.area != nil {
                interestChips
            }
        }
        .overlay {
            if model.area == nil {
                nothingChosenYet
            }
        }
        .navigationTitle(model.area?.label ?? "Entdecken")
        .plannerErrorBanner(model.errorMessage, retry: { await model.load() }, dismiss: { model.errorMessage = nil })
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Hier, wo ich bin", systemImage: "location") {
                        Task { await model.useCurrentLocation() }
                    }
                    Button("Andere Gegend\u{2026}", systemImage: "mappin.and.ellipse") {
                        isPickingArea = true
                    }
                    Divider()
                    Picker("Umkreis", selection: $model.radiusM) {
                        ForEach(TripExploreDefaults.radiusChoices, id: \.self) { metres in
                            Text(TripExploreDefaults.radiusLabel(metres)).tag(metres)
                        }
                    }
                    Divider()
                    // The other half of researching (§9.2 case 2): the
                    // browse answers "what is here", an article answers
                    // "what is worth going to", and until now reading
                    // one meant Safari, the share sheet and a trip.
                    Button("Artikel auslesen\u{2026}", systemImage: "doc.text.magnifyingglass") {
                        isReadingArticle = true
                    }
                    .disabled(model.area == nil)
                } label: {
                    Label("Gegend", systemImage: "line.3.horizontal.decrease.circle")
                }
                .disabled(model.isLocating)
            }
        }
        .task {
            model.ownerId = ownerId
            await model.loadInterests()
        }
        .onChange(of: model.chosenInterests) { _, _ in Task { await model.load() } }
        .onChange(of: model.question) { _, _ in Task { await model.load() } }
        .onChange(of: model.radiusM) { _, _ in Task { await model.load() } }
        .refreshable { await model.load() }
        .sheet(isPresented: $isReadingArticle) {
            if let area = model.area {
                TripArticleReadView(area: area, ownerId: ownerId)
            }
        }
        .sheet(isPresented: $isPickingArea) {
            TripExploreAreaSheet { place in
                isPickingArea = false
                Task { await model.use(place) }
            }
        }
        .navigationDestination(item: $opened) { spot in
            detail(spot)
        }
    }

    // MARK: - Before anything was asked

    private var nothingChosenYet: some View {
        ContentUnavailableView {
            Label("Wo wollt ihr euch umsehen?", systemImage: "binoculars")
        } description: {
            Text("Kein Trip n\u{00F6}tig \u{2014} was hier gefunden wird, geht in den Ideenvorrat.")
        } actions: {
            VStack(spacing: 12) {
                Button {
                    Task { await model.useCurrentLocation() }
                } label: {
                    Label(model.isLocating ? "Standort wird geholt\u{2026}" : "Hier, wo ich bin",
                          systemImage: "location")
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.isLocating)

                Button {
                    isPickingArea = true
                } label: {
                    Label("Andere Gegend\u{2026}", systemImage: "mappin.and.ellipse")
                }
                .buttonStyle(.bordered)
            }
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    // MARK: - What to look for

    private var interestChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                // The questions come first, and carry an icon so they
                // do not read as three more categories. „Es regnet, was
                // jetzt?" is a different kind of thing to tap than
                // „Museen" — and it is the question this app can answer
                // and a map app cannot (§3.1).
                ForEach(TripExploreQuestion.allCases) { question in
                    questionChip(question)
                }
                if !model.interests.isEmpty {
                    Divider().frame(height: 24)
                }
                ForEach(model.interests) { interest in
                    chip(interest)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .background(.bar)
    }

    private func questionChip(_ question: TripExploreQuestion) -> some View {
        let asked = model.question == question
        return Button {
            // One at a time: tapping the asked one puts it away.
            model.question = asked ? nil : question
        } label: {
            Label(question.label, systemImage: question.symbolName)
                .font(.subheadline)
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .background(asked ? Color.accentColor.opacity(0.18)
                                  : Color(uiColor: .secondarySystemFill))
                .foregroundStyle(asked ? Color.accentColor : Color.primary)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(asked ? AccessibilityTraits.isSelected : [])
    }

    private func chip(_ interest: TripInterestOption) -> some View {
        let chosen = model.chosenInterests.contains(interest.id)
        return Button {
            if chosen {
                model.chosenInterests.remove(interest.id)
            } else {
                model.chosenInterests.insert(interest.id)
            }
        } label: {
            Text(interest.label)
                .font(.subheadline)
                .padding(.horizontal, 14)
                // 44 pt tall, because Apple's own minimum is the one
                // number a row of little buttons always gets wrong.
                .frame(minHeight: 44)
                .background(chosen ? Color.accentColor.opacity(0.18)
                                   : Color(uiColor: .secondarySystemFill))
                .foregroundStyle(chosen ? Color.accentColor : Color.primary)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(chosen ? AccessibilityTraits.isSelected : [])
    }

    // MARK: - What is there

    @ViewBuilder
    private func row(_ spot: TripExploredSpot) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(spot.displayName).foregroundStyle(.primary)
                if let localName = spot.localName, !localName.isEmpty {
                    Text(localName).font(.footnote).foregroundStyle(.secondary)
                }
                Text(spot.factsLine).font(.footnote).foregroundStyle(.secondary)
                // Why it is up here rather than further down — the same
                // "Warum hier?" the plan owes for every suggestion (§8.3).
                if let reason = spot.reasons.first {
                    Text(reason).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            if model.isCollected(spot) {
                // Marked, not hidden — and not a button either: there is
                // nothing left to do to it.
                Image(systemName: "lightbulb.fill")
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("schon im Vorrat")
            }
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
        .frame(minHeight: 44)
        .contentShape(.rect)
    }

    /// Everything known about one find, on the screen a planned spot
    /// already uses — the question "where is that, and is it worth it?"
    /// does not change because nobody has kept the place yet.
    private func detail(_ spot: TripExploredSpot) -> some View {
        TripSpotDetailView(spot: TripSpotDetail(spot)) { close in
            if model.isCollected(spot) {
                Label("Schon im Vorrat", systemImage: "lightbulb.fill")
                    .foregroundStyle(.secondary)
            } else {
                Button {
                    Task {
                        await model.collect(spot)
                        close()
                    }
                } label: {
                    Label("In den Vorrat", systemImage: "lightbulb")
                }
                .disabled(model.addingRef != nil)
            }
        }
    }
}

/// Choosing the area to look around.
///
/// Its own sheet rather than two more rows on the results screen: a
/// place search is a search of its own, with its own results to pick
/// from, and putting those in the same list as the finds would leave
/// two kinds of row that look alike and mean different things.
struct TripExploreAreaSheet: View {
    let onPick: (TripPlace) -> Void

    @State private var finder = TripPlaceFinderModel()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    // A name is not a place: Apple geocodes, and nothing
                    // is searched until one of its answers is picked.
                    TripPlaceFinderRows(model: finder, picked: nil) { place in
                        onPick(place)
                    }
                } footer: {
                    Text("Die Gegend, in der gesucht wird \u{2014} eine Stadt, ein Ort, eine Region.")
                }
            }
            .navigationTitle("Gegend w\u{00E4}hlen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
            }
        }
    }
}
