import SwiftUI

/// One day of a plan: a card per block, spots as compact rows with the
/// way between them, and a utilisation line underneath (§8.3).
///
/// **The one screen for a day**, planning and walking alike. There used
/// to be a second one — "Unterwegs" (§8.5) — and the split turned out
/// to be the wrong seam: half the actions lived here and half there, so
/// using the planner meant switching back and forth for tasks that
/// belong to the same afternoon. §8.3 and §8.5 describe two *modes* of
/// one day, not two screens with different abilities, so the day is one
/// screen that knows whether you are standing in it: while a trip runs
/// the current block is marked, carries "Umplanen", and every stop
/// offers what you reach for on the spot — done, skipped, and the way
/// there.
///
/// Three things the concept asks for and this screen keeps:
///
///   - a block is a label and a budget, never a timetable — the rows
///     carry dwell times and walks, not clock times (§4.1);
///   - the hard times that *do* exist are shown as the frame they are,
///     above the blocks rather than inside them (§4.4);
///   - "Warum hier?" is one tap away on every spot. A plan nobody can
///     interrogate is a plan nobody trusts (§3.8).
struct TripPlanDayView: View {
    @State private var showSettings = false
    /// Which map app gets the handoff, when the traveller has not
    /// settled on one (§9.1).
    @State private var mapsChoice: TripMapsChoice?
    @AppStorage(TripMapsPreference.key) private var mapsPreference: String = TripMapsApp.apple.rawValue
    /// The stop whose "which block?" sheet is open, with the block it
    /// stands in now.
    @State private var moving: TripStopMove?
    /// Open while a hard time is being written (§4.4).
    @State private var addingFixpoint = false
    @State private var settingDayAnchor = false
    @State var viewModel: TripPlannerViewModel

    var body: some View {
        Group {
            if viewModel.isLoading && viewModel.plan == nil {
                ProgressView("Plan wird geladen…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let day = viewModel.day, let leg = viewModel.leg {
                content(day: day, leg: leg)
            } else if let message = viewModel.errorMessage {
                ContentUnavailableView("Plan nicht verfügbar", systemImage: "map", description: Text(message))
            } else {
                ContentUnavailableView("Kein Plan", systemImage: "map")
            }
        }
        .navigationTitle(viewModel.leg?.title ?? viewModel.plan?.title ?? "Plan")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let day = viewModel.day, let leg = viewModel.leg {
                // The map is the one thing reached often enough to earn
                // a button of its own; the rest live in a menu, because
                // five icons across a title bar is a puzzle.
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        TripDayMapView(day: day, anchor: leg.anchor,
                                       light: viewModel.light,
                                       isRunning: leg.schedule(on: Date()).isRunning)
                    } label: {
                        Label("Karte", systemImage: "map")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        // Everything this leg could do, and why (§5).
                        NavigationLink {
                            TripPoolView(viewModel: viewModel, legIndex: leg.position)
                        } label: {
                            Label("Vorrat (\(leg.pool.count))", systemImage: "tray.full")
                        }
                        // The way into the pool that needs nothing else
                        // — no share sheet, no map app, no model
                        // (§9.2, case 4).
                        NavigationLink {
                            TripPlaceSearchView(planId: viewModel.planId, legIndex: leg.position)
                        } label: {
                            Label("Ort suchen", systemImage: "magnifyingglass")
                        }
                        // „Ihr habt vier Ideen für Lissabon gesammelt"
                        // (§20.3) — offered here rather than pushed at
                        // the traveller when the trip is created: an
                        // idea from last year is not automatically the
                        // wish of this trip.
                        NavigationLink {
                            TripPlanIdeasView(viewModel: viewModel)
                        } label: {
                            Label("Aus dem Vorrat", systemImage: "lightbulb")
                        }
                        // The cities of the trip (§4.2) — add one,
                        // move an anchor, drop one that fell through.
                        NavigationLink {
                            TripLegsView(viewModel: viewModel)
                        } label: {
                            Label("Etappen (\(viewModel.plan?.legs.count ?? 1))",
                                  systemImage: "point.topleft.down.to.point.bottomright.curvepath")
                        }
                        // A day that happens somewhere else (§4.5).
                        // On the day's own menu rather than the leg's:
                        // it is this Tuesday that goes to Pisa, not the
                        // trip.
                        Button {
                            settingDayAnchor = true
                        } label: {
                            Label(viewModel.day?.anchor == nil
                                  ? "Ausflug planen"
                                  : "Ausflug ändern",
                                  systemImage: "car")
                        }
                        // Who else may plan this trip (§6.2) — a
                        // different question from who is coming along
                        // (§3.5, below), so a different word.
                        NavigationLink {
                            TripParticipantsView(planId: viewModel.planId)
                        } label: {
                            Label("Wer plant mit", systemImage: "person.2")
                        }
                        // When the light is good, after the planned
                        // day is over (§7.3). A sentence until
                        // somebody taps.
                        NavigationLink {
                            TripEveningLightView(
                                planId: viewModel.planId,
                                legIndex: viewModel.legIndex,
                                dayIndex: viewModel.dayIndex,
                            ) { Task { await viewModel.load() } }
                        } label: {
                            Label("Abendlicht", systemImage: "sun.horizon")
                        }
                        // Who changed what, and taking it back
                        // (§6.3) — several devices, one trip.
                        NavigationLink {
                            TripJournalView(planId: viewModel.planId) {
                                Task { await viewModel.load() }
                            }
                        } label: {
                            Label("Änderungen", systemImage: "arrow.uturn.backward")
                        }
                        // Everybody rates, nobody is averaged away
                        // (§6.1). Voting does not re-plan; the screen
                        // has a button for that.
                        NavigationLink {
                            TripBallotView(
                                planId: viewModel.planId,
                                legIndex: viewModel.legIndex,
                                leg: viewModel.leg,
                            ) {
                                Task { await viewModel.load() }
                            }
                        } label: {
                            Label("Abstimmen", systemImage: "hand.thumbsup")
                        }
                        // Who is actually coming (§3.5) — a child
                        // under ten makes the blocks shorter, so this
                        // re-plans the trip.
                        NavigationLink {
                            TripTravellersView(planId: viewModel.planId) {
                                Task { await viewModel.load() }
                            }
                        } label: {
                            Label("Wer fährt mit?", systemImage: "figure.2.and.child.holdinghands")
                        }
                        // The tickets and bookings this trip runs
                        // on (§3.4) — suggested, never taken over.
                        NavigationLink {
                            TripDocumentsView(planId: viewModel.planId)
                        } label: {
                            Label("Dokumente", systemImage: "doc.text")
                        }
                        // The evening before (§8.6): what is still
                        // cheap to fix tonight, and what to pack.
                        NavigationLink {
                            TripReadinessView(viewModel: viewModel)
                        } label: {
                            Label("Reisebereit?", systemImage: "checklist")
                        }
                        // And afterwards (§8.7): planned against what
                        // actually happened.
                        NavigationLink {
                            TripReviewView(planId: viewModel.planId)
                        } label: {
                            Label("Danach", systemImage: "clock.arrow.circlepath")
                        }
                        // Taking the plan along without a connection
                        // (§3.9) — asked for, never automatic.
                        NavigationLink {
                            TripOfflineView(viewModel: viewModel)
                        } label: {
                            Label("Unterwegs ohne Netz", systemImage: "wifi.slash")
                        }
                        Divider()
                        Button {
                            showSettings = true
                        } label: {
                            Label("Einstellungen", systemImage: "slider.horizontal.3")
                        }
                    } label: {
                        Label("Mehr", systemImage: "ellipsis.circle")
                    }
                }
            }
        }
        .confirmationDialog(
            "Navigation öffnen mit",
            isPresented: Binding(get: { mapsChoice != nil }, set: { if !$0 { mapsChoice = nil } }),
            titleVisibility: .visible,
        ) {
            if let choice = mapsChoice {
                Button("Apple Karten") { openMaps(choice, with: .apple) }
                Button("Google Maps") { openMaps(choice, with: .google) }
                Button("Abbrechen", role: .cancel) {}
            }
        }
        .sheet(isPresented: $settingDayAnchor) {
            TripDayAnchorSheet(
                dayLabel: dayLabel(),
                current: viewModel.day?.anchor,
            ) { draft in
                await viewModel.setDayAnchor(draft)
            }
        }
        .sheet(isPresented: $addingFixpoint) {
            TripFixpointSheet(
                dayLabel: dayLabel(),
            ) { draft in
                await viewModel.addFixpoint(draft)
            }
        }
        .sheet(item: $moving) { move in
            NavigationStack {
                TripBlockPickerView(
                    title: move.stop.displayName,
                    leg: viewModel.leg,
                    current: (dayIndex: viewModel.dayIndex, blockId: move.blockId),
                ) { blockId, dayIndex in
                    await viewModel.move(move.stop, toDayIndex: dayIndex, toBlockId: blockId)
                    moving = nil
                }
            }
        }
        .sheet(isPresented: $showSettings) {
            NavigationStack {
                TripPlanSettingsView(
                    planId: viewModel.planId,
                    constraints: viewModel.plan?.constraints,
                    title: viewModel.plan?.title,
                    // The mode and the dates live on the legs rather
                    // than in the constraints, so they are handed over
                    // separately — from the first leg, which is what
                    // "the trip" means for a screen with one of each.
                    mode: viewModel.plan?.legs.first?.transportMode ?? .foot,
                    startDate: viewModel.plan?.startDate,
                    firstLeg: viewModel.plan?.legs.first,
                ) {
                    // Saving re-plans the days, so the screen behind has
                    // to be told rather than left showing the old ones.
                    Task { await viewModel.load() }
                }
            }
        }
        .task {
            await viewModel.load()
            watchStops()
            await viewModel.loadLight()
            await viewModel.loadForecast()
        }
        .onDisappear { TripVisitMonitor.shared.stop() }
        .onChange(of: viewModel.dayIndex) { _, _ in
            watchStops()
            // A different day is a different sun, and a different sky.
            Task {
                await viewModel.loadLight()
                await viewModel.loadForecast()
            }
        }
        .onChange(of: viewModel.legIndex) { _, _ in
            watchStops()
            Task {
                await viewModel.loadLight()
                await viewModel.loadForecast()
            }
        }
    }

    /// Put geofences around the next stops of the day on screen (§7.1).
    ///
    /// Driven from the day view rather than started once at launch: the
    /// fences are only worth having around the day you are actually on,
    /// and re-deriving them when the day or leg changes is cheaper than
    /// keeping a second copy of "which day are we looking at".
    private func watchStops() {
        let stops = viewModel.stopsOfDay
        guard !stops.isEmpty else {
            TripVisitMonitor.shared.stop()
            return
        }
        TripVisitMonitor.shared.watch(
            planId: viewModel.planId,
            stops: stops,
            stopIdsByRef: Dictionary(stops.map { ($0.osmRef, $0.rowId) },
                                     uniquingKeysWith: { first, _ in first }),
        )
    }

    @ViewBuilder
    private func content(day: TripDay, leg: TripLeg) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                offlineBanner
                legHeader(leg)
                if leg.isAwaitingRegion {
                    awaitingRegionCard(leg)
                }
                fixpointBand(day)
                if day.detailed {
                    weatherOfferCard(day)
                    ForEach(day.blocks) { block in
                        blockCard(block)
                    }
                } else {
                    tripResolutionCard(day)
                }
            }
            .padding()
        }
        .safeAreaInset(edge: .top) {
            VStack(spacing: 0) {
                // Only for a trip that has more than one: a chooser
                // with a single entry is noise on the screen people
                // look at most.
                if (viewModel.plan?.legs.count ?? 1) > 1 { legPicker }
                dayPicker(leg)
            }
        }
    }

    // MARK: - Offline

    /// What is on screen, and how old it is (§3.9).
    ///
    /// The plan itself needs no apology — a day made of blocks is as
    /// true in a tunnel as it was in the hotel. What needs saying is
    /// the age, and the two things that are not there: the map and the
    /// weather (§14). Anything else would let somebody wait for a
    /// forecast that is never coming.
    @ViewBuilder
    private var offlineBanner: some View {
        if let since = viewModel.offlineSince {
            VStack(alignment: .leading, spacing: 4) {
                Label("Offline — \(TripOfflineWording.stamp(since))", systemImage: "wifi.slash")
                    .font(.subheadline.weight(.semibold))
                Text("Der Plan liegt auf dem Gerät. Karte und Wetter fehlen, und Änderungen "
                     + "brauchen eine Verbindung.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.3), in: .rect(cornerRadius: 14))
        }
    }

    // MARK: - Rearranging for the weather

    /// The offer, and only when the weather gives a reason for one (§7.2).
    ///
    /// The button is shown when a block of the day is wet or hot enough
    /// that the server would have something to say; whether it actually
    /// has is decided by the server, and an offer of nothing is shown
    /// as a sentence rather than as an empty sheet.
    @ViewBuilder
    private func weatherOfferCard(_ day: TripDay) -> some View {
        if let forecast = viewModel.forecast, forecast.available, weatherIsAnArgument(forecast) {
            VStack(alignment: .leading, spacing: 8) {
                Label("Das Wetter spricht gegen diesen Tag, so wie er geplant ist.",
                      systemImage: "cloud.rain")
                    .font(.subheadline)
                Text("Der Planer kann Spots unter Dach nach vorn holen und ausgesetzte "
                     + "zurück in den Vorrat legen. Er zeigt vorher, was er täte.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button {
                    Task { await viewModel.proposeWeatherReplan() }
                } label: {
                    if viewModel.isWeatherReplanning {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        Label("Vorschlag ansehen", systemImage: "arrow.triangle.2.circlepath")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.bordered)
                .disabled(viewModel.isWeatherReplanning)

                if !viewModel.weatherMoves.isEmpty {
                    // What was actually done, by name. A day that
                    // rearranges itself silently is a day nobody trusts.
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Ans Wetter angepasst:").font(.footnote.weight(.semibold))
                        ForEach(viewModel.weatherMoves) { move in
                            Text("· \(moveSentence(move, day: day))").font(.footnote)
                        }
                    }
                    .foregroundStyle(.secondary)
                }
            }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.3), in: .rect(cornerRadius: 14))
            .sheet(item: Binding(
                get: { viewModel.weatherProposal.map { WeatherOffer(proposal: $0) } },
                set: { if $0 == nil { viewModel.dismissWeatherProposal() } },
            )) { offer in
                weatherProposalSheet(offer.proposal, day: day)
            }
        }
    }

    /// Wrapper so the proposal can drive `.sheet(item:)` — it is data,
    /// not an identity, and `Identifiable` on the model itself would be
    /// a lie about what it is.
    private struct WeatherOffer: Identifiable {
        let proposal: TripWeatherProposal
        var id: String { proposal.reason + proposal.moves.map(\.osmRef).joined(separator: "|") }
    }

    @ViewBuilder
    private func weatherProposalSheet(_ proposal: TripWeatherProposal, day: TripDay) -> some View {
        NavigationStack {
            List {
                if let sentence = proposal.blockedSentence {
                    Section {
                        Text(sentence).foregroundStyle(.secondary)
                    }
                } else {
                    Section {
                        ForEach(proposal.moves) { move in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(move.displayName)
                                Text(moveSentence(move, day: day))
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    } header: {
                        Text("Vorgeschlagen")
                    } footer: {
                        Text("Nichts davon ist gespeichert. Erst mit „Umräumen\" ändert sich der Tag.")
                    }
                }
            }
            .navigationTitle("Wetter")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Lassen") { viewModel.dismissWeatherProposal() }
                }
                if proposal.offered {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Umräumen") {
                            Task { await viewModel.applyWeatherReplan() }
                        }
                        .disabled(viewModel.isWeatherReplanning)
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }

    /// "Aussichtspunkt → Vorrat", in the day's own block names.
    private func moveSentence(_ move: TripWeatherMove, day: TripDay) -> String {
        let from = day.blocks.first { $0.id == move.fromBlockId }?.label ?? move.fromBlockId
        guard let toId = move.toBlockId else {
            return move.reason == "budget"
                ? "\(from) → Vorrat (der Tag wird bei dem Wetter kürzer)"
                : "\(from) → Vorrat (zu ausgesetzt für das Wetter)"
        }
        let to = day.blocks.first { $0.id == toId }?.label ?? toId
        return "\(from) → \(to)"
    }

    /// Whether the sky says enough to be worth an offer. The server
    /// decides for real; this only keeps the button off a fine day.
    private func weatherIsAnArgument(_ forecast: TripDayForecast) -> Bool {
        forecast.blocks.contains { block in
            guard let weather = block.weather else { return false }
            return weather.wetness != "dry" || weather.heat == "hot"
        }
    }

    // MARK: - Header and navigation between days

    /// The leg is framed and empty because its maps are still being
    /// imported (§4.3).
    ///
    /// Said out loud, because the alternative is a day with nothing on
    /// it and no explanation — and "es lädt noch" is something a person
    /// can wait out, while an empty day is something they conclude the
    /// app is broken over (§8.3). The button is for the impatient: the
    /// server fills these in by itself once the import lands.
    private func awaitingRegionCard(_ leg: TripLeg) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Die Karten für \(leg.displayTitle) fehlen noch",
                  systemImage: "map.circle")
                .font(.subheadline.weight(.semibold))
            Text("Der Kartenausschnitt wird heruntergeladen — das dauert je nach Region "
                 + "eine Weile und kann auf eine Freigabe warten. Die Tage stehen schon: "
                 + "sobald die Karten da sind, füllen sie sich von selbst.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            if let reason = viewModel.fillBlockedReason {
                Text(reason)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Button {
                Task { await viewModel.fillPending() }
            } label: {
                if viewModel.isFilling {
                    ProgressView()
                } else {
                    Label("Jetzt nachsehen", systemImage: "arrow.clockwise")
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(viewModel.isFilling)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
    }

    private func legHeader(_ leg: TripLeg) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            // Where the day begins and ends, said out loud. It is the
            // value the whole plan is measured from (§4.2), and the
            // screen used to show only how the group gets around.
            //
            // A located fixpoint moves one of the two ends (§4.4), and
            // then the anchor alone would be the wrong sentence: on the
            // day of the last train the evening finishes at the
            // platform, and a header still promising the hotel is the
            // one line somebody would plan the evening by.
            HStack(spacing: 6) {
                Image(systemName: headerSymbol(leg))
                Text(headerLine(leg))
                    .lineLimit(2)
                Spacer()
            }
            HStack(spacing: 6) {
                Image(systemName: leg.transportMode.systemImage)
                Text(leg.transportMode.label)
                if viewModel.dayIndex == 0, let arrival = leg.arriveMinutes {
                    // Only on the day it applies to: the arrival
                    // shortens the first day and no other.
                    Text("· Ankunft \(TripClock.format(arrival))")
                }
                Spacer()
            }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
    }

    private func headerSymbol(_ leg: TripLeg) -> String {
        if viewModel.day?.anchor != nil { return "car" }
        return leg.anchorRadiusM == nil ? "house" : "circle.dashed"
    }

    /// "Start: Hauptbahnhof · Ziel: Hotel Adler" — the day's two ends.
    ///
    /// Falls back to the sentence it always had, because on nearly
    /// every day both ends *are* the accommodation and naming it twice
    /// would be noise.
    private func headerLine(_ leg: TripLeg) -> String {
        // A day trip says where the day is, not where the bed is: the
        // anchor is still true and no longer the useful half (§4.5).
        if let trip = viewModel.day?.anchor {
            return "Ausflug: \(trip.summary)"
        }
        let anchor = leg.anchorRadiusM == nil
            ? leg.anchorTitle
            : "\(leg.anchorTitle) (ungefähr)"
        let ends = viewModel.day.map(TripDayEnds.of)
        switch (ends?.start, ends?.end) {
        case (nil, nil):
            return leg.anchorRadiusM == nil
                ? "Start & Ziel: \(anchor)"
                : "Rund um \(leg.anchorTitle) · Unterkunft noch offen"
        case let (start?, nil):
            return "Start: \(start.label) · Ziel: \(anchor)"
        case let (nil, end?):
            return "Start: \(anchor) · Ziel: \(end.label)"
        case let (start?, end?):
            return "Start: \(start.label) · Ziel: \(end.label)"
        }
    }

    /// Which city of the trip is on screen (§4.2).
    ///
    /// Without this a trip through three cities showed the first one
    /// and nothing else: every screen behind the day — the pool, the
    /// map, moving a spot — is scoped to the leg on screen, so the
    /// other two were unreachable rather than merely unshown.
    private var legPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(viewModel.plan?.legs.sorted(by: { $0.position < $1.position }) ?? []) { leg in
                    Button {
                        viewModel.select(leg: leg.position)
                    } label: {
                        HStack(spacing: 4) {
                            Text(leg.displayTitle)
                                .font(.subheadline.weight(
                                    leg.position == viewModel.legIndex ? .semibold : .regular))
                            if leg.isAwaitingRegion {
                                Image(systemName: "map.circle").font(.caption2)
                            }
                        }
                        .padding(.vertical, 6)
                        .padding(.horizontal, 12)
                        .background(
                            leg.position == viewModel.legIndex
                                ? AnyShapeStyle(.tint.opacity(0.15))
                                : AnyShapeStyle(.clear),
                            in: .capsule,
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal)
            .padding(.top, 6)
        }
        .background(.bar)
    }

    private func dayPicker(_ leg: TripLeg) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(leg.days) { day in
                    Button {
                        viewModel.dayIndex = day.dayIndex
                    } label: {
                        VStack(spacing: 2) {
                            Text("Tag \(day.dayIndex + 1)")
                                .font(.subheadline.weight(day.dayIndex == viewModel.dayIndex ? .semibold : .regular))
                            // The date, once the trip has one. Without
                            // it "Tag 3" is a number the traveller has
                            // to work out from the calendar.
                            if let date = leg.date(ofDayIndex: day.dayIndex) {
                                Text(date)
                                    .font(.caption2)
                                    .foregroundStyle(
                                        leg.isToday(dayIndex: day.dayIndex)
                                            ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                            }
                            // A day still at trip resolution is marked, so
                            // an empty-looking day never reads as a day
                            // with nothing to do (§4.3).
                            if !day.detailed {
                                Image(systemName: "circle.dashed")
                                    .font(.caption2)
                            }
                        }
                        .frame(minWidth: 56)
                        .padding(.vertical, 6)
                        .padding(.horizontal, 10)
                        .background(
                            day.dayIndex == viewModel.dayIndex
                                ? AnyShapeStyle(.tint.opacity(0.15))
                                : AnyShapeStyle(.clear),
                            in: .rect(cornerRadius: 10),
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 6)
        }
        .background(.bar)
    }

    // MARK: - The frame

    /// The hard times of the day, and the way to say one (§4.4).
    ///
    /// Shown even when there are none: the last train was the thing
    /// nobody could enter, and a band that only appears once a fixpoint
    /// exists is a band nobody finds. Kept quiet in that case — one
    /// line, no card.
    private func fixpointBand(_ day: TripDay) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(day.fixpoints) { fix in
                HStack(spacing: 8) {
                    Image(systemName: fix.isDeparture ? "arrow.right.to.line" : "calendar.badge.clock")
                        .foregroundStyle(fix.isDeparture ? .orange : .secondary)
                    Text(fix.startsAt).monospacedDigit().font(.subheadline.weight(.semibold))
                    VStack(alignment: .leading, spacing: 1) {
                        Text(fix.label).font(.subheadline)
                        // What it costs the day, which is the reason a
                        // block got shorter — said rather than left to
                        // be discovered in the budget.
                        if fix.travelMinutes > 0 || fix.durationMinutes > 0 {
                            Text(costSentence(fix))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        // And what its place does, which is more than
                        // decoration: it moved the day's route (§4.4).
                        if let effect = placeEffect(fix) {
                            Label(effect, systemImage: "mappin.and.ellipse")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Button(role: .destructive) {
                        Task { await viewModel.removeFixpoint(fix) }
                    } label: {
                        Image(systemName: "xmark.circle")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .disabled(viewModel.isSavingFixpoint)
                    .accessibilityLabel("\(fix.label) entfernen")
                }
            }

            Button {
                addingFixpoint = true
            } label: {
                Label(day.fixpoints.isEmpty ? "Feste Zeit eintragen" : "Weitere feste Zeit",
                      systemImage: "clock.badge.exclamationmark")
                    .font(.footnote)
            }
            .buttonStyle(.plain)
            .disabled(viewModel.isSavingFixpoint)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(day.fixpoints.isEmpty
                    ? AnyShapeStyle(.clear)
                    : AnyShapeStyle(.quaternary.opacity(0.4)),
                    in: .rect(cornerRadius: 12))
    }

    /// What naming a place did to this day, or nothing when it did
    /// nothing — a fixpoint in the middle of the day keeps its time and
    /// moves no route, and claiming otherwise would be the more
    /// confident of the two lies.
    private func placeEffect(_ fix: TripFixpoint) -> String? {
        guard fix.hasPlace, let ends = viewModel.day.map(TripDayEnds.of) else { return nil }
        if ends.end?.rowId == fix.rowId { return "Der Tag endet hier" }
        if ends.start?.rowId == fix.rowId { return "Der Tag beginnt hier" }
        return nil
    }

    /// "Tag 3 · Fr, 18.9." — which day the sheet is writing to, so a
    /// hard time never lands on a day nobody was looking at.
    private func dayLabel() -> String {
        let number = "Tag \(viewModel.dayIndex + 1)"
        guard let date = viewModel.leg?.date(ofDayIndex: viewModel.dayIndex) else { return number }
        return "\(number) · \(date)"
    }

    /// "Weg 15 min · dauert 1 h" — why a block is shorter than it was.
    private func costSentence(_ fix: TripFixpoint) -> String {
        var parts: [String] = []
        if fix.travelMinutes > 0 { parts.append("Weg \(TripClock.duration(fix.travelMinutes))") }
        if fix.durationMinutes > 0 { parts.append("dauert \(TripClock.duration(fix.durationMinutes))") }
        return parts.joined(separator: " · ")
    }

    private func tripResolutionCard(_ day: TripDay) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            // A buffer day is empty for the opposite reason to an
            // unplanned one: not "too far away to plan" but "kept free
            // on purpose" (§7.2). Saying the same thing about both
            // would make the precaution look like a gap.
            Label(day.isBuffer ? "Puffertag" : "Noch nicht im Detail geplant",
                  systemImage: day.isBuffer ? "umbrella" : "circle.dashed")
                .font(.headline)
            Text(day.isBuffer
                 ? (day.bufferReason ?? "")
                 : "Der Rahmen steht — die Blöcke und ihre Zeiten. Die Spots kommen "
                   + "üblicherweise am Vorabend dazu, wenn Wetter und Lust bekannt sind.")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            ForEach(day.blocks) { block in
                HStack {
                    Text(block.label)
                    Spacer()
                    Text(TripClock.duration(block.budgetMinutes))
                        .foregroundStyle(.secondary)
                }
                .font(.subheadline)
            }

            Button {
                Task { await viewModel.detailCurrentDay() }
            } label: {
                if viewModel.isDetailing {
                    ProgressView()
                } else {
                    Text("Diesen Tag jetzt planen")
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(viewModel.isDetailing)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.3), in: .rect(cornerRadius: 14))
    }

    // MARK: - Block cards

    /// Where this block sits on the day — what the split call names it
    /// by, since a template id is not a position.
    private func blockIndex(of block: TripBlock) -> Int? {
        viewModel.day?.blocks.firstIndex { $0.id == block.id }
    }

    private func blockCard(_ block: TripBlock) -> some View {
        let isCurrent = currentBlockId == block.id
        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(block.label).font(.headline)
                if isCurrent {
                    // Where the group is right now — the one thing
                    // "Unterwegs" did that the day plan could not say.
                    Text("jetzt")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.tint.opacity(0.15), in: .capsule)
                }
                Spacer()
                Text("ca. \(TripClock.duration(block.usedMinutes)) von \(TripClock.duration(block.budgetMinutes))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                // Separating and coming back together (§6.5). On the
                // block, because that is what a split is an attribute
                // of — not a second trip.
                Menu {
                    if block.isSplit {
                        Button("Wieder zusammen") { Task { await viewModel.removeSplit(block) } }
                    } else if let index = blockIndex(of: block) {
                        NavigationLink("Trennen") {
                            TripSplitView(
                                planId: viewModel.planId,
                                dayIndex: viewModel.dayIndex,
                                blockIndex: index,
                                blockLabel: block.label,
                            ) { Task { await viewModel.load() } }
                        }
                    }
                } label: {
                    Image(systemName: "arrow.triangle.branch")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            // Who went where, when the group separated (§6.5).
            if let branches = block.branches, !branches.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(branches) { branch in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(branch.label).font(.subheadline)
                            Text(branch.subtitle)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }

            ProgressView(value: min(block.utilisation, 1))
                // Over budget is the one state that has to be
                // unmistakable, because it is the one the traveller has
                // to decide about (§8.4).
                .tint(block.utilisation > 1 ? .red : .accentColor)

            // What the sky is expected to do over this block (§7.2).
            // Said, not acted on: nothing here reorders the block, and
            // the budget bar above is the planned one, not a shrunken
            // one — the app must not show a number the plan does not
            // hold.
            if let weather = viewModel.forecast?.weather(forBlock: block.id) {
                VStack(alignment: .leading, spacing: 2) {
                    Label(weather.summary, systemImage: weather.symbolName)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if let sentence = weather.budgetSentence {
                        Text(sentence)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if block.isMeal {
                // A meal block holds time and a rough area, not a venue:
                // the planner never picks a restaurant (§10.3). Finding
                // somewhere is the second stage, and it happens on the
                // spot rather than at the planning table.
                VStack(alignment: .leading, spacing: 6) {
                    Label("Zeit fürs Essen — der Planer sucht kein Lokal aus.",
                          systemImage: "fork.knife")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if let leg = viewModel.leg {
                        NavigationLink {
                            TripFoodListView(position: leg.anchor)
                        } label: {
                            Label("Essen in der Nähe", systemImage: "fork.knife.circle")
                                .font(.footnote)
                        }
                    }
                }
            } else if block.stops.isEmpty {
                // "Nichts geplant" on its own is a dead end: the pool
                // next door is full of things that would fit, and until
                // now nothing on this screen said so or led there.
                VStack(alignment: .leading, spacing: 6) {
                    Text("Nichts geplant.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if let leg = viewModel.leg, !leg.pool.isEmpty {
                        NavigationLink {
                            TripPoolView(viewModel: viewModel, legIndex: leg.position)
                        } label: {
                            Label("Aus dem Vorrat füllen (\(leg.pool.count))",
                                  systemImage: "tray.full")
                                .font(.footnote)
                        }
                    }
                }
            } else {
                ForEach(Array(block.stops.enumerated()), id: \.element.rowId) { index, stop in
                    if index > 0 || stop.travelFromPrevious.minutes > 0 {
                        travelRow(stop.travelFromPrevious)
                    }
                    stopRow(stop, in: block)
                }
                if let leg = viewModel.leg {
                    Button {
                        // The whole block at once: Apple takes an array
                        // of destinations and Google knows waypoints, so
                        // the morning walks over in one piece rather
                        // than a leg at a time.
                        offerMaps(.block(block.stops.map(\.coordinate), mode: leg.transportMode))
                    } label: {
                        Label("Ganzen Block in Karten öffnen",
                              systemImage: "arrow.triangle.turn.up.right.diamond")
                            .font(.footnote)
                    }
                    .buttonStyle(.plain)
                }
            }

            if isCurrent { replanRow() }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isCurrent ? AnyShapeStyle(.tint.opacity(0.08)) : AnyShapeStyle(.quaternary.opacity(0.3)),
                    in: .rect(cornerRadius: 14))
        .overlay {
            if isCurrent {
                RoundedRectangle(cornerRadius: 14).stroke(.tint.opacity(0.4), lineWidth: 1)
            }
        }
    }

    /// "Umplanen", where it belongs: on the block you are standing in
    /// (§8.5). It was the big button of a screen of its own; the button
    /// was never the point, the block was.
    @ViewBuilder
    private func replanRow() -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider()
            Button {
                Task { await viewModel.redistributeNow() }
            } label: {
                if viewModel.isRedistributing {
                    ProgressView().frame(maxWidth: .infinity)
                } else {
                    Label("Ab hier umplanen", systemImage: "arrow.triangle.2.circlepath")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.bordered)
            .disabled(viewModel.isRedistributing)

            if let reason = viewModel.redistributeBlockedReason {
                // Why it did not run, in words that say what to do about
                // it — never a silent no-op.
                Text(reason).font(.footnote).foregroundStyle(.secondary)
            }
            if !viewModel.displaced.isEmpty {
                // What lost its place. A count would not be reviewable;
                // the names are (§5).
                VStack(alignment: .leading, spacing: 2) {
                    Text("Zurück in den Vorrat:").font(.footnote.weight(.semibold))
                    ForEach(viewModel.displaced) { stop in
                        Text("· \(stop.displayName)").font(.footnote)
                    }
                }
                .foregroundStyle(.secondary)
            }
        }
    }

    private func travelRow(_ travel: TripTravel) -> some View {
        HStack(spacing: 6) {
            Image(systemName: travel.symbolName)
            Text("\(travel.minutes) min")
            Spacer()
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.leading, 4)
    }

    private func stopRow(_ stop: TripStop, in block: TripBlock) -> some View {
        let reasons = viewModel.reasons(for: stop)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                if stop.pinned {
                    Image(systemName: "pin.fill").foregroundStyle(.orange)
                }
                if stop.isPhotoStop {
                    Image(systemName: "camera.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Fotostopp")
                }
                // The same screen a pool candidate opens: "where is
                // that, and why is it on the list" is one question, and
                // answering it twice is how two screens drift apart.
                NavigationLink {
                    TripSpotDetailView(
                        spot: TripSpotDetail(stop),
                        mode: viewModel.leg?.transportMode ?? .foot,
                        onSave: { await viewModel.saveNote($0) },
                        light: viewModel.light?.hint(for: stop.osmRef),
                        shelter: viewModel.forecast?.shelter(for: stop.osmRef),
                    ) { closeDetail in
                        // The same section the pool shows: one
                        // decision, one way of making it.
                        Section {
                            Button {
                                moving = TripStopMove(stop: stop, blockId: block.id)
                            } label: {
                                Label("In einen anderen Block", systemImage: "calendar")
                            }
                            Button {
                                Task { await viewModel.setPinned(stop, !stop.pinned) }
                            } label: {
                                Label(stop.pinned ? "Nicht mehr anheften" : "Anheften",
                                      systemImage: stop.pinned ? "pin.slash" : "pin")
                            }
                            // "Nicht heute Nachmittag" (§8.4): out of
                            // the day, back into the running.
                            if stop.stopStatus == .planned {
                                Button {
                                    // Back to the day afterwards: this
                                    // screen would otherwise go on
                                    // describing a stop that has just
                                    // left it.
                                    Task {
                                        await viewModel.returnToPool(stop)
                                        closeDetail()
                                    }
                                } label: {
                                    Label("Zurück in den Vorrat", systemImage: "tray.and.arrow.down")
                                }
                            }
                            // "Not this one, and not next time either"
                            // (§5): the way to stop the search from
                            // proposing a place that is simply not
                            // wanted. Reversible under "Ausgeblendet"
                            // in the pool.
                            Button(role: .destructive) {
                                Task {
                                    await viewModel.hide(osmRef: stop.osmRef)
                                    closeDetail()
                                }
                            } label: {
                                Label("Für diese Reise ausblenden", systemImage: "eye.slash")
                            }
                        } footer: {
                            // The two ways out, side by side, because
                            // the difference is the whole point.
                            Text("Zurück in den Vorrat heißt „nicht heute“ — er bleibt im "
                                 + "Rennen. Ausblenden heißt „nicht auf dieser Reise“.")
                        }
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(stop.displayName)
                            .strikethrough(stop.stopStatus == .skipped)
                        Text(TripClock.duration(stop.dwellMinutes))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)
                Spacer()
                if stop.stopStatus == .done {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                }
                // Routing somewhere is only useful once you are
                // travelling. Planning at the kitchen table, the same
                // tap should answer "where is that?" — a route from
                // home to a café you will walk to next month is a
                // number nobody wants.
                Button {
                    if isTravelling {
                        offerMaps(.single(stop.coordinate,
                                          mode: viewModel.leg?.transportMode ?? .foot))
                    } else {
                        TripMapsOpen.pin(stop.coordinate, name: stop.name,
                                         using: TripMapsPreference.load())
                    }
                } label: {
                    Image(systemName: isTravelling
                          ? "arrow.triangle.turn.up.right.circle"
                          : "mappin.circle")
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isTravelling
                                    ? "Navigation zu \(stop.displayName)"
                                    : "\(stop.displayName) auf der Karte zeigen")
                // Ticking a spot off is the gesture of the day itself
                // (§8.5) — a menu rather than a swipe, because these
                // rows live in cards, not in a list.
                Menu {
                    Button {
                        Task { await viewModel.mark(stop, as: .done) }
                    } label: {
                        Label("Erledigt", systemImage: "checkmark")
                    }
                    Button {
                        Task { await viewModel.mark(stop, as: .skipped) }
                    } label: {
                        Label("Übersprungen", systemImage: "xmark")
                    }
                    if stop.stopStatus != .planned {
                        Button {
                            Task { await viewModel.mark(stop, as: .planned) }
                        } label: {
                            Label("Doch wieder offen", systemImage: "arrow.uturn.backward")
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Was mit \(stop.displayName) ist")
                if !reasons.isEmpty {
                    Button {
                        viewModel.toggleReasons(for: stop.osmRef)
                    } label: {
                        Image(systemName: viewModel.expandedReasons.contains(stop.osmRef)
                              ? "questionmark.circle.fill" : "questionmark.circle")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Warum hier?")
                }
            }

            if viewModel.expandedReasons.contains(stop.osmRef) {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(reasons, id: \.self) { reason in
                        Text("· \(reason)")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.15), value: viewModel.expandedReasons)
    }

    // MARK: - While you are out

    /// Which block the clock says the group is in — marked only while a
    /// trip is actually running.
    ///
    /// Trip mode is what knows whether you are travelling: it is the
    /// thing that gets started when you set off. Guessing from dates
    /// would light up "jetzt" on a Tuesday afternoon in the planning
    /// month, which is exactly the claim §15.3 warns against.
    private var currentBlockId: String? {
        guard isTravelling, let day = viewModel.day, viewModel.isToday else { return nil }
        return TripDayTimeline.block(in: day, at: TripDayTimeline.minutesOfDay(Date()))?.id
    }

    private var isTravelling: Bool { TripStore.shared.isActive }

    private func offerMaps(_ choice: TripMapsChoice) {
        let availability = TripMapsAvailability(
            preference: TripMapsApp(rawValue: mapsPreference) ?? .apple,
            googleAppInstalled: TripMapsOpen.googleInstalled,
        )
        if let app = availability.resolved {
            TripMapsOpen.route(choice, using: app)
        } else {
            mapsChoice = choice
        }
    }

    private func openMaps(_ choice: TripMapsChoice, with app: TripMapsApp) {
        mapsChoice = nil
        TripMapsOpen.route(choice, using: app)
    }
}
