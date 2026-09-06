import SwiftUI

/// One day of a plan: a card per block, spots as compact rows with the
/// way between them, and a utilisation line underneath (§8.3).
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
                        TripDayMapView(day: day, anchor: leg.anchor)
                    } label: {
                        Label("Karte", systemImage: "map")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        // Not "Heute": the screen is not a date, it is
                        // the one you use while you are actually out —
                        // the block you are in, what is left of it, and
                        // the big "umplanen" (§8.5). A sun said nothing
                        // about any of that.
                        NavigationLink {
                            TripTodayView(viewModel: viewModel)
                        } label: {
                            Label("Unterwegs", systemImage: "figure.walk")
                        }
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
                        // The cities of the trip (§4.2) — add one,
                        // move an anchor, drop one that fell through.
                        NavigationLink {
                            TripLegsView(viewModel: viewModel)
                        } label: {
                            Label("Etappen (\(viewModel.plan?.legs.count ?? 1))",
                                  systemImage: "point.topleft.down.to.point.bottomright.curvepath")
                        }
                        // Who else is on the trip (§6.2).
                        NavigationLink {
                            TripParticipantsView(planId: viewModel.planId)
                        } label: {
                            Label("Mitreisende", systemImage: "person.2")
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
        }
        .onDisappear { TripVisitMonitor.shared.stop() }
        .onChange(of: viewModel.dayIndex) { _, _ in watchStops() }
        .onChange(of: viewModel.legIndex) { _, _ in watchStops() }
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
                legHeader(leg)
                if leg.isAwaitingRegion {
                    awaitingRegionCard(leg)
                }
                if !day.fixpoints.isEmpty {
                    fixpointBand(day.fixpoints)
                }
                if day.detailed {
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
            HStack(spacing: 6) {
                Image(systemName: leg.anchorRadiusM == nil ? "house" : "circle.dashed")
                Text(leg.anchorRadiusM == nil
                     ? "Start & Ziel: \(leg.anchorTitle)"
                     : "Rund um \(leg.anchorTitle) · Unterkunft noch offen")
                    .lineLimit(1)
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

    private func fixpointBand(_ fixpoints: [TripFixpoint]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(fixpoints) { fix in
                HStack(spacing: 8) {
                    Image(systemName: fix.isDeparture ? "arrow.right.to.line" : "calendar.badge.clock")
                        .foregroundStyle(fix.isDeparture ? .orange : .secondary)
                    Text(fix.startsAt).monospacedDigit().font(.subheadline.weight(.semibold))
                    Text(fix.label).font(.subheadline)
                    Spacer()
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.4), in: .rect(cornerRadius: 12))
    }

    private func tripResolutionCard(_ day: TripDay) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Noch nicht im Detail geplant", systemImage: "circle.dashed")
                .font(.headline)
            Text("Der Rahmen steht — die Blöcke und ihre Zeiten. Die Spots kommen "
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

    private func blockCard(_ block: TripBlock) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(block.label).font(.headline)
                Spacer()
                Text("ca. \(TripClock.duration(block.usedMinutes)) von \(TripClock.duration(block.budgetMinutes))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            ProgressView(value: min(block.utilisation, 1))
                // Over budget is the one state that has to be
                // unmistakable, because it is the one the traveller has
                // to decide about (§8.4).
                .tint(block.utilisation > 1 ? .red : .accentColor)

            if block.isMeal {
                // A meal block holds time and a rough area, not a venue:
                // the planner never picks a restaurant (§10.3).
                Label("Zeit fürs Essen — der Planer sucht kein Lokal aus.", systemImage: "fork.knife")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
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
                    stopRow(stop)
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.3), in: .rect(cornerRadius: 14))
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

    private func stopRow(_ stop: TripStop) -> some View {
        let reasons = viewModel.reasons(for: stop)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                if stop.pinned {
                    Image(systemName: "pin.fill").foregroundStyle(.orange)
                }
                // The same screen a pool candidate opens: "where is
                // that, and why is it on the list" is one question, and
                // answering it twice is how two screens drift apart.
                NavigationLink {
                    TripSpotDetailView(
                        spot: TripSpotDetail(stop),
                        mode: viewModel.leg?.transportMode ?? .foot,
                    )
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
}
