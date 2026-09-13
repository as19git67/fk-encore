import SwiftUI

/// Recherche in der App: what is here, before there is a trip (§9.2, §20).
///
/// The four ways into the pool all assume the research already
/// happened — a link from a map app, an article, a screenshot, a name
/// you type. This is the step before: *what is here at all?* The region
/// databases have been able to answer it since the first import, and
/// only the solver ever asked.
///
/// Three things the screen insists on.
///
/// **It works without a trip.** The area comes from the phone or from a
/// place picked out of Apple's geocoder, and what is found goes into the
/// idea collection, which has never needed a journey (§20). Collecting
/// in March for a holiday booked in July is the ordinary case, not the
/// exotic one.
///
/// **A tap is the query.** Interests are chips, not a wheel in a
/// settings screen, and the list fills with no text typed at all. The
/// name field stays for the case it was built for — you know what the
/// place is called — but it is no longer the only way in.
///
/// **An empty list says which kind of empty it is.** A region nobody
/// imported, a filter too narrow, and an area with nothing in it are
/// three different answers, and the server names which one this is.
struct TripExploreView: View {
    @State private var model = TripExploreViewModel()
    @State private var finder = TripPlaceFinderModel()
    /// Which collection a find goes into. Nil means one's own.
    let ownerId: Int?

    init(ownerId: Int? = nil) {
        self.ownerId = ownerId
    }

    var body: some View {
        List {
            areaSection

            if model.area != nil {
                filterSection
                resultsSection
            }
        }
        .navigationTitle("Entdecken")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            model.ownerId = ownerId
            await model.loadInterests()
        }
    }

    // MARK: - Where to look

    @ViewBuilder
    private var areaSection: some View {
        Section {
            Button {
                Task { await model.useCurrentLocation() }
            } label: {
                Label(model.isLocating ? "Standort wird geholt…" : "Hier, wo ich bin",
                      systemImage: "location")
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(model.isLocating)

            // A name is not a place: Apple geocodes, and nothing is
            // searched until one of its answers has been picked.
            TripPlaceFinderRows(model: finder, picked: nil) { place in
                Task { await model.use(place) }
            }
        } header: {
            Text("Gegend")
        } footer: {
            if let area = model.area {
                Text("Gesucht wird um \(area.label).")
            } else {
                Text("Kein Trip nötig — was hier gefunden wird, geht in den Ideenvorrat.")
            }
        }
    }

    // MARK: - What to look for

    @ViewBuilder
    private var filterSection: some View {
        Section {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(model.interests) { interest in
                        chip(interest)
                    }
                }
                .padding(.vertical, 4)
            }
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))

            Picker("Umkreis", selection: $model.radiusM) {
                ForEach(TripExploreDefaults.radiusChoices, id: \.self) { metres in
                    Text(TripExploreDefaults.radiusLabel(metres)).tag(metres)
                }
            }

            HStack {
                TextField("Name (optional)", text: $model.query)
                    .submitLabel(.search)
                    .autocorrectionDisabled()
                    .onSubmit { Task { await model.load() } }
                if model.isLoading {
                    ProgressView()
                } else {
                    Button("Suchen") { Task { await model.load() } }
                        .buttonStyle(.borderless)
                }
            }
        }
        .onChange(of: model.chosenInterests) { _, _ in Task { await model.load() } }
        .onChange(of: model.radiusM) { _, _ in Task { await model.load() } }
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
                // number a list of little buttons always gets wrong.
                .frame(minHeight: 44)
                .background(chosen ? Color.accentColor.opacity(0.18) : Color(uiColor: .secondarySystemFill))
                .foregroundStyle(chosen ? Color.accentColor : Color.primary)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(chosen ? AccessibilityTraits.isSelected : [])
    }

    // MARK: - What is there

    @ViewBuilder
    private var resultsSection: some View {
        Section {
            if let message = model.lastAddition {
                Text(message).font(.footnote).foregroundStyle(.secondary)
            }
            if let error = model.errorMessage {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
            // Said rather than left blank: the three kinds of empty are
            // three different things to do next.
            if let note = model.note, model.spots.isEmpty {
                Text(note).foregroundStyle(.secondary)
            }

            ForEach(model.spots) { spot in
                row(spot)
            }

            if model.hasMore {
                Text("Es gibt mehr — enger eingrenzen hilft.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text(model.spots.isEmpty ? "Ergebnis" : "Gefunden")
        }
    }

    @ViewBuilder
    private func row(_ spot: TripExploredSpot) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(spot.displayName)
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
            collectButton(spot)
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func collectButton(_ spot: TripExploredSpot) -> some View {
        if model.isCollected(spot) {
            // Marked, not hidden — and not a button either: there is
            // nothing left to do to it.
            Label("im Vorrat", systemImage: "checkmark.circle.fill")
                .labelStyle(.iconOnly)
                .foregroundStyle(.secondary)
                .frame(width: 44, height: 44)
                .accessibilityLabel("\(spot.displayName) ist schon im Vorrat")
        } else {
            Button {
                Task { await model.collect(spot) }
            } label: {
                Image(systemName: "lightbulb")
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(model.addingRef != nil)
            .accessibilityLabel("\(spot.displayName) merken")
        }
    }
}
